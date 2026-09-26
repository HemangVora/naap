import solc from 'solc';
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
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { USDC_ABI, USDC_ADDRESS, unitsToUsd, usdcBalanceSlot, usdToUnits } from '@crumple/chain';
import type { GuardConfirmation, GuardFinding, GuardReport } from './types.js';
import { CONFIRMABLE, scanSource } from './scan.js';

// Deploy Guard engine: static scan always; compile (solc-js, no imports); and — only with a fork rpcUrl — deploy the
// contract to the local anvil Base fork and try each confirmable finding from a random ATTACKER EOA, ONLY against
// that just-deployed contract, inside evm_snapshot/evm_revert so nothing persists. Defensive: the proof exists to
// show the contract's own author the flaw. audit() never throws — any fork failure falls back to the static-only
// report. See docs/superpowers/specs/2026-09-27-deploy-guard-design.md.

export interface GuardEngine {
  /** Audit one single-file Solidity source. Static always; deploy + dynamic proof when a fork rpcUrl is configured. */
  audit(source: string, opts?: { name?: string }): Promise<GuardReport>;
}

/** Best-effort contract name from the source. */
export function contractNameOf(source: string): string {
  return source.match(/\bcontract\s+(\w+)/)?.[1] ?? 'Contract';
}

const SANDBOX_USD = 1000; // USDC seeded into the deployed contract
const GAS_WEI = 100n * 10n ** 18n; // deployer + attacker gas money
const CONTRACT_WEI = 10n ** 18n; // ETH seeded into the contract so native-drain flaws are provable too
const MINT_AMOUNT = 1_000_000n * 10n ** 18n;

type Compiled = { ok: true; name: string; abi: Abi; bytecode: Hex } | { ok: false; error: string };

/** solc standard-JSON compile: paris, optimizer on, pragma forced to ^0.8.24, every import rejected. */
function compile(source: string): Compiled {
  try {
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

/** Constructor args we can supply: none, or a single address (the token → Base USDC). Anything else → no deploy. */
function constructorArgs(abi: Abi): unknown[] | null {
  const ctor = abi.find((x) => x.type === 'constructor');
  const inputs = ctor && 'inputs' in ctor ? ctor.inputs : [];
  if (inputs.length === 0) return [];
  if (inputs.length === 1 && inputs[0].type === 'address') return [USDC_ADDRESS];
  return null;
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
  ctorArgs: unknown[],
  findings: GuardFinding[],
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
    const hash = await wallet.sendTransaction({ account, chain, ...tx });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`);
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

    const deployed = await send(deployer, { data: encodeDeployData({ abi, bytecode: compiled.bytecode, args: ctorArgs } as never) });
    const target = deployed.contractAddress;
    if (!target) throw new Error('deploy produced no contract address');
    await anvil('anvil_setStorageAt', [USDC_ADDRESS, usdcBalanceSlot(target), numberToHex(usdToUnits(SANDBOX_USD), { size: 32 })]);
    await anvil('anvil_setBalance', [target, numberToHex(CONTRACT_WEI)]);

    /** One attacker transaction against the sandbox contract; resolves only if it succeeded AND moved something. */
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
        throw new Error('nothing moved');
      }
      if (id === 'unprotected-mint') {
        const bal = abi.filter(isFn).find((x) => x.name === 'balanceOf' && x.inputs.length === 1 && x.inputs[0].type === 'address' && !mutates(x));
        const supply = getter(abi, ['totalSupply'], /^totalSupply$/, 'int');
        const measure = async () => ((await read(target, bal, [who])) ?? (await read(target, supply))) as bigint | undefined;
        const before = await measure();
        if (before === undefined) throw new Error('no balanceOf/totalSupply to verify a mint');
        const r = await call(MINT_AMOUNT);
        const minted = ((await measure()) ?? before) - before;
        if (minted <= 0n) throw new Error('nothing minted');
        const decimals = Number((await read(target, getter(abi, ['decimals'], /^decimals$/, 'int')).catch(() => undefined)) ?? 18);
        return { exploit: `A stranger called ${sig} and minted ${formatUnits(minted, decimals)} tokens to themselves.`, txHash: r.transactionHash };
      }
      if (id === 'missing-access-control') {
        const g = getter(abi, ['owner', 'admin', 'governance', 'getOwner'], /owner|admin/i, 'address');
        const before = (await read(target, g)) as Address | undefined;
        if (!before || isAddressEqual(before, who)) throw new Error('no owner getter to verify');
        const r = await call(0n);
        const after = (await read(target, g)) as Address;
        if (!isAddressEqual(after, who)) throw new Error('owner unchanged');
        return { exploit: `A stranger called ${sig} and made themselves the owner.`, txHash: r.transactionHash, ownerBefore: before, ownerAfter: after };
      }
      if (id === 'unprotected-price') {
        const g = getter(abi, ['price', 'getPrice', 'latestAnswer', 'answer', 'latestPrice', 'currentPrice', 'rate', 'exchangeRate'], /price|rate|answer/i, 'int');
        const before = (await read(target, g)) as bigint | undefined;
        if (before === undefined) throw new Error('no price getter to verify');
        const r = await call(before === 1n ? 2n : 1n);
        const after = (await read(target, g)) as bigint;
        if (after === before) throw new Error('price unchanged');
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
      } catch {
        out.push(f); // a revert (or an unfillable / unverifiable call) = not confirmed
      }
    }
    return { address: target, chainId, findings: out };
  } finally {
    await anvil('evm_revert', [snapshot]).catch(() => undefined);
  }
}

export function createGuardEngine(cfg: { rpcUrl?: string } = {}): GuardEngine {
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
      const compiled = compile(source);
      if (!compiled.ok) return { ...base, verdict: 'COMPILE_ERROR', compileError: compiled.error };

      const report: GuardReport = { ...base, contractName: opts?.name ?? compiled.name, verdict: verdictOf(findings) };
      const ctorArgs = constructorArgs(compiled.abi);
      const rpcUrl = cfg.rpcUrl;
      if (!rpcUrl || !ctorArgs) return report;
      try {
        const proven = await serial(() => deployAndProve(rpcUrl, compiled, ctorArgs, findings));
        return { ...report, ...proven, verdict: verdictOf(proven.findings) };
      } catch {
        return report; // fork down, deploy reverted, … → static-only
      }
    },
  };
}
