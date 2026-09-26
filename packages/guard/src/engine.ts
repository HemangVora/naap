import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  formatUnits,
  http,
  isAddressEqual,
  numberToHex,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { USDC_ABI, USDC_ADDRESS, unitsToUsd, usdcBalanceSlot, usdToUnits } from '@crumple/chain';
import type { GuardConfirmation, GuardFinding, GuardReport } from './types.js';
import { CONFIRMABLE, scanSource, stripComments } from './scan.js';

// Deploy Guard engine: static scan always; compile (solc-js, no imports); and — only with a fork rpcUrl — deploy the
// contract to the local anvil Base fork and try each confirmable finding from a random ATTACKER EOA, ONLY against
// that just-deployed contract, inside evm_snapshot/evm_revert so nothing persists. Defensive: the proof exists to
// show the contract's own author the flaw. audit() never throws — any fork failure falls back to the static-only
// report. See docs/superpowers/specs/2026-09-27-deploy-guard-design.md.

export interface GuardEngine {
  /** Audit one single-file Solidity source. Static always; deploy + dynamic proof when a fork rpcUrl is configured. */
  audit(source: string, opts?: { name?: string }): Promise<GuardReport>;
}

/** Best-effort contract name from the source (comments ignored, so "// a contract for tips" never names it "for"). */
export function contractNameOf(source: string): string {
  return stripComments(source).match(/\bcontract\s+(\w+)/)?.[1] ?? 'Contract';
}

const SANDBOX_USD = 1000; // USDC seeded into the deployed contract
const GAS_WEI = 100n * 10n ** 18n; // deployer + attacker gas money
const CONTRACT_WEI = 10n ** 18n; // ETH seeded into the contract so native-drain flaws are provable too
const MINT_AMOUNT = 1_000_000n * 10n ** 18n;
/** Explicit gas on every sandbox tx: no eth_estimateGas, so a hostile constructor/probe cannot fan out into upstream RPC calls. */
const TX_GAS = 8_000_000n;
/** Constructor integers (a cap, a rate, a supply…): 1,000,000 in 6-decimal units, clamped to the parameter's type. */
const CTOR_UINT = 1_000_000n * 10n ** 6n;

type Solc = { compile(input: string, opts?: { import?: (path: string) => { contents?: string; error?: string } }): string };
let solcLoad: Promise<Solc> | undefined;
/** solc-js is ~10 MB of wasm glue: load it on the first compile, not at server boot. A failed load is retried next time. */
function loadSolc(): Promise<Solc> {
  solcLoad ??= import('solc').then((m) => ((m as { default?: Solc }).default ?? (m as unknown as Solc)));
  solcLoad.catch(() => (solcLoad = undefined));
  return solcLoad;
}

type Compiled = { ok: true; name: string; abi: Abi; bytecode: Hex } | { ok: false; error: string };

/** solc standard-JSON compile: paris, optimizer on, pragma forced to ^0.8.24, every import rejected. */
async function compile(source: string): Promise<Compiled> {
  try {
    const solc = await loadSolc();
    const content = source.replace(/\bpragma\s+solidity\s+[^;]*;/g, 'pragma solidity ^0.8.24;');
    const input = {
      language: 'Solidity',
      sources: { 'Contract.sol': { content } },
      settings: {
        evmVersion: 'paris',
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      },
    };
    const out = JSON.parse(
      solc.compile(JSON.stringify(input), { import: () => ({ error: 'imports are not supported in the sandbox' }) }),
    ) as {
      errors?: { severity: string; formattedMessage?: string; message: string }[];
      contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
    };
    const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
    if (errors.length) return { ok: false, error: errors.map((e) => (e.formattedMessage ?? e.message).trim()).join('\n\n').slice(0, 4000) };
    // the last contract with bytecode (interfaces/abstract contracts have none; the main contract is usually last)
    let pick: Compiled | undefined;
    for (const file of Object.values(out.contracts ?? {}))
      for (const [name, c] of Object.entries(file))
        if (c.evm.bytecode.object) pick = { ok: true, name, abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
    return pick ?? { ok: false, error: 'No deployable contract found (only interfaces or abstract contracts).' };
  } catch (e) {
    return { ok: false, error: `Compiler failed: ${(e as Error).message}` };
  }
}

const verdictOf = (findings: GuardFinding[]): GuardReport['verdict'] =>
  findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'VULNERABLE' : 'SAFE';

/** Constructor arguments for the sandbox deploy, given the deployer; or why they cannot be filled (→ static-only). */
export type CtorPlan = { ok: true; args: (deployer: Address) => unknown[] } | { ok: false; reason: string };

/** One constructor value: a token-ish address → Base USDC, any other address → the deployer, integers, bool, strings, bytes. */
function ctorArg(p: AbiParameter, deployer: Address, only: boolean): unknown {
  const t = p.type;
  if (t === 'address') return /token|usdc|asset|currency/i.test(p.name ?? '') || (only && !p.name) ? USDC_ADDRESS : deployer;
  if (t === 'bool') return false;
  if (t === 'string') return 'Sandbox';
  if (t === 'bytes') return '0x';
  const fixed = /^bytes(\d+)$/.exec(t);
  if (fixed) return `0x${'00'.repeat(Number(fixed[1]))}`;
  const int = /^(u?)int(\d*)$/.exec(t);
  if (int) {
    const max = (1n << (BigInt(int[2] || 256) - (int[1] ? 0n : 1n))) - 1n;
    return CTOR_UINT > max ? max : CTOR_UINT;
  }
  return undefined; // arrays, tuples, …
}

export function constructorPlan(abi: Abi): CtorPlan {
  const ctor = abi.find((x) => x.type === 'constructor');
  const inputs: readonly AbiParameter[] = ctor && 'inputs' in ctor ? ctor.inputs : [];
  const bad = inputs.find((p) => ctorArg(p, zeroAddress, inputs.length === 1) === undefined);
  if (bad) return { ok: false, reason: `constructor parameter ${bad.name || '?'} of type ${bad.type} cannot be filled generically` };
  return { ok: true, args: (deployer) => inputs.map((p) => ctorArg(p, deployer, inputs.length === 1)) };
}

/** A sandbox tx that was mined but reverted. */
class TxReverted extends Error {}
/**
 * An attacker tx that went through but did not move the value the probe reads. NOT evidence of a guard: the probe's
 * getter is picked by name (owner/admin, price/rate, USDC/ETH), not from what the function writes — setAdmin() can
 * succeed while owner() stays put. So the finding keeps its severity.
 */
class NoEffect extends Error {}

/**
 * A confirmable finding whose attacker call actually ran on the fork and REVERTED: the function is almost certainly
 * gated by a check the scanner does not recognise. Kept as a medium note to review, not a flaw. Only a revert earns
 * this downgrade (the page counts these notes as "attack calls reverted on the fork").
 */
export function unconfirmed(f: GuardFinding): GuardFinding {
  return {
    ...f,
    severity: 'medium',
    title: `Unconfirmed: ${f.title}`,
    detail: `${f.detail} On the sandbox fork a stranger’s call to it reverted, so it looks gated by a check the scanner doesn’t recognise. Review it.`,
  };
}

/** Generic attacker-chosen value for one ABI parameter; null when the type is not generically fillable. */
function genericArg(p: AbiParameter, attacker: Address, uint: bigint): unknown {
  const t = p.type;
  if (t === 'address') return attacker;
  if (t === 'bool') return true;
  if (t === 'string') return '';
  if (t === 'bytes') return '0x';
  const int = /^(u?)int(\d*)$/.exec(t);
  if (int) {
    const bits = BigInt(int[2] || 256) - (int[1] ? 0n : 1n);
    const max = (1n << bits) - 1n;
    return uint > max ? max : uint;
  }
  const fixed = /^bytes(\d+)$/.exec(t);
  if (fixed) return `0x${'00'.repeat(Number(fixed[1]))}`;
  return null; // arrays, tuples, …
}

const isFn = (x: Abi[number]): x is AbiFunction => x.type === 'function';
const mutates = (x: AbiFunction) => x.stateMutability !== 'view' && x.stateMutability !== 'pure';

/** A zero-arg view getter returning an address or an integer, by preferred name, then by pattern. */
function getter(abi: Abi, names: string[], pattern: RegExp, out: 'address' | 'int'): AbiFunction | undefined {
  const views = abi.filter(isFn).filter(
    (x) =>
      !mutates(x) &&
      x.inputs.length === 0 &&
      x.outputs.length === 1 &&
      (out === 'address' ? x.outputs[0].type === 'address' : /^u?int\d*$/.test(x.outputs[0].type)),
  );
  return names.map((n) => views.find((v) => v.name === n)).find(Boolean) ?? views.find((v) => pattern.test(v.name));
}

async function deployAndProve(
  rpcUrl: string,
  compiled: Extract<Compiled, { ok: true }>,
  ctor: Extract<CtorPlan, { ok: true }>,
  findings: GuardFinding[],
  log: (msg: string) => void,
): Promise<{ address: Address; chainId: number; findings: GuardFinding[] }> {
  const transport = http(rpcUrl, { retryCount: 1, timeout: 20_000 });
  const chainId = await createPublicClient({ transport }).getChainId();
  const chain = defineChain({
    id: chainId,
    name: 'Base (anvil fork)',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport, pollingInterval: 100 });
  const wallet = createWalletClient({ chain, transport });
  const anvil = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never }) as Promise<unknown>;
  const { abi } = compiled;

  const send = async (account: PrivateKeyAccount, tx: { to?: Address; data: Hex }) => {
    const hash = await wallet.sendTransaction({ account, chain, gas: TX_GAS, ...tx });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== 'success') throw new TxReverted(`tx ${hash} reverted`);
    return receipt;
  };
  const read = (address: Address, fn: AbiFunction | undefined, args: unknown[] = []): Promise<unknown> =>
    fn ? pub.readContract({ address, abi: [fn], functionName: fn.name, args } as never) : Promise.resolve(undefined);
  const usdcOf = (who: Address) => pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [who] });

  const snapshot = (await anvil('evm_snapshot', [])) as Hex;
  try {
    const deployer = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const who = attacker.address;
    await anvil('anvil_setBalance', [deployer.address, numberToHex(GAS_WEI)]);
    await anvil('anvil_setBalance', [who, numberToHex(GAS_WEI)]);

    const deployed = await send(deployer, { data: encodeDeployData({ abi, bytecode: compiled.bytecode, args: ctor.args(deployer.address) } as never) }).catch(
      (e: Error) => {
        throw new Error(e instanceof TxReverted ? 'the constructor reverted on the fork' : `deploy failed: ${e.message.split('\n')[0]}`);
      },
    );
    const target = deployed.contractAddress;
    if (!target) throw new Error('deploy produced no contract address');
    await anvil('anvil_setStorageAt', [USDC_ADDRESS, usdcBalanceSlot(target), numberToHex(usdToUnits(SANDBOX_USD), { size: 32 })]);
    await anvil('anvil_setBalance', [target, numberToHex(CONTRACT_WEI)]);

    /** One attacker transaction against the sandbox contract; resolves only if it succeeded AND moved something.
     *  Throws TxReverted if the tx reverted, NoEffect if it succeeded but the value read did not change. */
    const probe = async (id: string, fn: AbiFunction): Promise<GuardConfirmation> => {
      const sig = `${fn.name}(${fn.inputs.map((p) => p.type).join(',')})`;
      const call = (uint: bigint) => {
        const args = fn.inputs.map((p) => genericArg(p, who, uint));
        if (args.includes(null)) throw new Error(`cannot build generic args for ${sig}`);
        return send(attacker, { to: target, data: encodeFunctionData({ abi: [fn], functionName: fn.name, args } as never) });
      };

      if (id === 'unprotected-withdraw') {
        const [usdcBefore, ethBefore] = await Promise.all([usdcOf(who), pub.getBalance({ address: who })]);
        const r = await call(usdToUnits(SANDBOX_USD));
        const [usdcAfter, ethAfter] = await Promise.all([usdcOf(who), pub.getBalance({ address: who })]);
        if (usdcAfter > usdcBefore) {
          const usd = unitsToUsd(usdcAfter - usdcBefore);
          return { exploit: `A stranger called ${sig} and drained $${usd} USDC from the contract.`, txHash: r.transactionHash, stolenUsd: usd };
        }
        const ethGain = ethAfter - ethBefore + r.gasUsed * r.effectiveGasPrice;
        if (ethGain > 0n) return { exploit: `A stranger called ${sig} and took ${formatUnits(ethGain, 18)} ETH from the contract.`, txHash: r.transactionHash };
        throw new NoEffect('nothing moved');
      }
      if (id === 'unprotected-mint') {
        const bal = abi.filter(isFn).find((x) => x.name === 'balanceOf' && x.inputs.length === 1 && x.inputs[0].type === 'address' && !mutates(x));
        const supply = getter(abi, ['totalSupply'], /^totalSupply$/, 'int');
        const measure = async () => ((await read(target, bal, [who])) ?? (await read(target, supply))) as bigint | undefined;
        const before = await measure();
        if (before === undefined) throw new Error('no balanceOf/totalSupply to verify a mint');
        const r = await call(MINT_AMOUNT);
        const minted = ((await measure()) ?? before) - before;
        if (minted <= 0n) throw new NoEffect('nothing minted');
        const decimals = Number((await read(target, getter(abi, ['decimals'], /^decimals$/, 'int')).catch(() => undefined)) ?? 18);
        return { exploit: `A stranger called ${sig} and minted ${formatUnits(minted, decimals)} tokens to themselves.`, txHash: r.transactionHash };
      }
      if (id === 'missing-access-control') {
        const g = getter(abi, ['owner', 'admin', 'governance', 'getOwner'], /owner|admin/i, 'address');
        const before = (await read(target, g)) as Address | undefined;
        if (!before || isAddressEqual(before, who)) throw new Error('no owner getter to verify');
        const r = await call(0n);
        const after = (await read(target, g)) as Address;
        if (!isAddressEqual(after, who)) throw new NoEffect('owner unchanged');
        return { exploit: `A stranger called ${sig} and made themselves the owner.`, txHash: r.transactionHash, ownerBefore: before, ownerAfter: after };
      }
      if (id === 'unprotected-price') {
        const g = getter(abi, ['price', 'getPrice', 'latestAnswer', 'answer', 'latestPrice', 'currentPrice', 'rate', 'exchangeRate'], /price|rate|answer/i, 'int');
        const before = (await read(target, g)) as bigint | undefined;
        if (before === undefined) throw new Error('no price getter to verify');
        const r = await call(before === 1n ? 2n : 1n);
        const after = (await read(target, g)) as bigint;
        if (after === before) throw new NoEffect('price unchanged');
        return { exploit: `A stranger called ${sig} and moved the price from ${before} to ${after}.`, txHash: r.transactionHash };
      }
      throw new Error(`no probe for ${id}`);
    };

    const out: GuardFinding[] = [];
    for (const f of findings) {
      const name = f.where?.match(/^(\w+)\(/)?.[1];
      const fn = CONFIRMABLE.has(f.id) ? abi.filter(isFn).find((x) => x.name === name && mutates(x)) : undefined;
      try {
        out.push(fn ? { ...f, confirmed: await probe(f.id, fn) } : f);
      } catch (e) {
        // The attacker call ran and reverted → a review note. It succeeded but the value we read did not move (we may
        // be reading the wrong variable), or it could not be probed at all (unfillable args, no getter to verify, an
        // RPC hiccup) → the static finding stands as is.
        if (e instanceof TxReverted) out.push(unconfirmed(f));
        else {
          const why = e instanceof NoEffect ? "probe succeeded but the checked value didn't move" : 'not run';
          log(`probe of ${f.where ?? f.id} ${why}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
          out.push(f);
        }
      }
    }
    return { address: target, chainId, findings: out };
  } finally {
    await anvil('evm_revert', [snapshot]).catch(() => undefined);
  }
}

export function createGuardEngine(cfg: { rpcUrl?: string; log?: (msg: string) => void } = {}): GuardEngine {
  const log = cfg.log ?? ((msg: string) => console.warn(`[guard] ${msg}`));
  // one dynamic audit at a time: interleaved snapshot/revert pairs would wipe each other's sandbox
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  return {
    async audit(source, opts) {
      let findings: GuardFinding[] = [];
      try {
        findings = scanSource(source);
      } catch {
        /* the scanner is best-effort; compile + fork still run */
      }
      const base = { contractName: opts?.name ?? contractNameOf(source), findings, source, auditedAt: Date.now() };
      const compiled = await compile(source);
      if (!compiled.ok) return { ...base, verdict: 'COMPILE_ERROR', compileError: compiled.error };

      const report: GuardReport = { ...base, contractName: opts?.name ?? compiled.name, verdict: verdictOf(findings) };
      const rpcUrl = cfg.rpcUrl;
      if (!rpcUrl) return report;
      const ctor = constructorPlan(compiled.abi);
      if (!ctor.ok) {
        log(`${report.contractName}: static-only, ${ctor.reason}`);
        return report;
      }
      try {
        const proven = await serial(() => deployAndProve(rpcUrl, compiled, ctor, findings, log));
        return { ...report, ...proven, verdict: verdictOf(proven.findings) };
      } catch (e) {
        log(`${report.contractName}: static-only, ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`); // fork down, ctor reverted, …
        return report;
      }
    },
  };
}
