// MandateSource on ENSv2 Sepolia: <carId>.crumple.eth subnames in our UserRegistry, mandate text records on our PermissionedResolver.
// Writes go through the single relayer nonce queue and are asynchronous; reads go through the ENSv2 UniversalResolver.
import { encodeFunctionData, zeroAddress } from 'viem';
import { MANDATE_KEYS, PARENT_ENS, type Address, type Hex, type Mandate, type MandateSource } from '@crumple/core';
import { registryAbi, resolverAbi } from './abi.js';
import { ENSV2, REGISTRAR } from './addresses.js';
import { proveAgentCannotEdit as proveEac, type EacProof } from './eac.js';
import { agentAccountFor } from './local.js';
import { errorText, type QueuedResult } from './nonceQueue.js';
import { createRelayer, type Relayer } from './relayer.js';
import { PARENT_LABEL, carEnsName, defaultMandateFor, dnsName, encodeMandateRecords, labelId, labelOf, parseMandateRecords, toLabel, type TextRecord } from './records.js';

export interface EnsMandateConfig {
  rpcUrl: string;
  relayerPk: Hex;
  log?: (line: string) => void;
  /** Override on-chain discovery (ETHRegistry.getSubregistry/getResolver("crumple")). */
  userRegistry?: Address;
  resolver?: Address;
  agentSeed?: string;
  /** Cache TTL for ENS address resolution, ms (default 60s). */
  resolveTtlMs?: number;
}

export interface EnsLayout {
  userRegistry: Address;
  resolver: Address;
}

export type WriteStatus = 'pending' | 'confirmed' | 'failed' | 'unknown';

export interface EnsMandateSource extends MandateSource {
  readonly mode: 'ens';
  readonly relayer: Relayer;
  layout(): Promise<EnsLayout>;
  /** Chain reachable + crumple.eth set up? Throws with a human message otherwise. */
  probe(timeoutMs?: number): Promise<EnsLayout>;
  status(ensName: string): WriteStatus;
  /** Resolves with the tx hash of the mandate write once mined; rejects if it failed. */
  whenConfirmed(ensName: string): Promise<Hex>;
  onConfirmed(cb: (ensName: string, txHash: Hex) => void): void;
  readRecords(ensName: string, keys: readonly string[]): Promise<Record<string, string | null>>;
  /** Multicall of setText on our resolver, through the relayer queue. */
  writeText(ensName: string, records: TextRecord[]): Promise<QueuedResult>;
  /** Register `<label>.crumple.eth` in the UserRegistry (idempotent) with our resolver. */
  registerSubname(label: string, owner: Address, opts?: { resolver?: Address; expirySec?: number }): Promise<{ hash?: Hex; existed: boolean }>;
  proveAgentCannotEdit(ensName: string, opts?: { send?: boolean; fund?: boolean; key?: string }): Promise<EacProof>;
}

interface Entry {
  mandate: Mandate;
  status: WriteStatus;
  txHash?: Hex;
  error?: string;
  promise: Promise<Hex>;
}

export function createEnsMandateSource(cfg: EnsMandateConfig): EnsMandateSource {
  const log = cfg.log ?? ((l: string) => console.log(`[ens] ${l}`));
  const relayer = createRelayer({ rpcUrl: cfg.rpcUrl, privateKey: cfg.relayerPk, log });
  const pc = relayer.publicClient;
  const entries = new Map<string, Entry>();
  const cbs: ((ensName: string, txHash: Hex) => void)[] = [];
  const resolveCache = new Map<string, { at: number; address: Address | null }>();
  const resolveTtl = cfg.resolveTtlMs ?? 60_000;
  let layoutP: Promise<EnsLayout> | null = null;

  async function discoverLayout(): Promise<EnsLayout> {
    const [reg, res] = await Promise.all([
      cfg.userRegistry ?? pc.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: 'getSubregistry', args: [PARENT_LABEL] }),
      cfg.resolver ?? pc.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: 'getResolver', args: [PARENT_LABEL] }),
    ]);
    if (reg === zeroAddress || res === zeroAddress) {
      throw new Error(`${PARENT_ENS} has no subregistry/resolver on ENSv2 Sepolia yet — run \`pnpm --filter @crumple/ens register\``);
    }
    return { userRegistry: reg, resolver: res };
  }

  const layout = () => (layoutP ??= discoverLayout().catch((e) => { layoutP = null; throw e; }));

  async function readRecords(ensName: string, keys: readonly string[]) {
    const out: Record<string, string | null> = {};
    await Promise.all(
      keys.map(async (key) => {
        try {
          out[key] = await pc.getEnsText({ name: ensName, key, universalResolverAddress: ENSV2.universalResolver });
        } catch (e) {
          log(`getEnsText(${ensName}, ${key}) failed: ${errorText(e).slice(0, 120)}`);
          out[key] = null;
        }
      }),
    );
    return out;
  }

  async function writeText(ensName: string, records: TextRecord[]) {
    const { resolver } = await layout();
    const name = dnsName(ensName);
    const calls = records.map((r) => encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [name, r.key, r.value] }));
    return relayer.queue.submit({
      to: resolver,
      data: encodeFunctionData({ abi: resolverAbi, functionName: 'multicall', args: [calls] }),
      label: `setText×${records.length} ${ensName}`,
    });
  }

  async function registerSubname(label: string, owner: Address, opts: { resolver?: Address; expirySec?: number } = {}) {
    const lay = await layout();
    const resolver = opts.resolver ?? lay.resolver;
    const existingOwner = await pc.readContract({ address: lay.userRegistry, abi: registryAbi, functionName: 'findOwner', args: [label] });
    if (existingOwner !== zeroAddress) {
      const current = await pc.readContract({ address: lay.userRegistry, abi: registryAbi, functionName: 'getResolver', args: [label] });
      if (current.toLowerCase() !== resolver.toLowerCase()) {
        const r = await relayer.queue.submit({
          to: lay.userRegistry,
          data: encodeFunctionData({ abi: registryAbi, functionName: 'setResolver', args: [labelId(label), resolver] }),
          label: `setResolver ${label}.${PARENT_ENS}`,
        });
        if (r.status !== 'success') throw new Error(`setResolver(${label}) reverted: ${r.hash}`);
        return { hash: r.hash, existed: true };
      }
      return { existed: true };
    }
    // ERC1155 mint to a contract needs a receiver; fall back to the relayer as token owner.
    let tokenOwner = owner && owner !== zeroAddress ? owner : relayer.address;
    if (tokenOwner !== relayer.address) {
      const code = await pc.getCode({ address: tokenOwner }).catch(() => undefined);
      if (code && code !== '0x') tokenOwner = relayer.address;
    }
    const expiry = BigInt(opts.expirySec ?? Math.floor(Date.now() / 1000) + REGISTRAR.durationSec);
    // roleBitmap 0: the subname owner (the agent side) gets NO roles — it cannot change resolver/subregistry or transfer.
    const r = await relayer.queue.submit({
      to: lay.userRegistry,
      data: encodeFunctionData({ abi: registryAbi, functionName: 'register', args: [label, tokenOwner, zeroAddress, resolver, 0n, expiry] }),
      label: `register ${label}.${PARENT_ENS}`,
    });
    if (r.status !== 'success') throw new Error(`register(${label}) reverted: ${r.hash}`);
    return { hash: r.hash, existed: false };
  }

  const src: EnsMandateSource = {
    mode: 'ens',
    relayer,
    layout,
    async probe(timeoutMs = 8_000) {
      const t = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Sepolia RPC did not answer within ${timeoutMs}ms`)), timeoutMs).unref?.());
      return Promise.race([
        (async () => {
          const id = await pc.getChainId();
          if (id !== 11155111) throw new Error(`SEPOLIA_RPC_URL is chain ${id}, expected Sepolia (11155111)`);
          return layout();
        })(),
        t,
      ]);
    },
    readRecords,
    writeText,
    registerSubname,

    async createForCar(carId, owner) {
      const label = toLabel(carId);
      const ensName = carEnsName(carId);
      const key = ensName.toLowerCase();
      const existing = entries.get(key);
      if (existing && existing.status !== 'failed') return copy(existing.mandate, await resolvedPayees(existing.mandate));

      const mandate = defaultMandateFor(carId, owner, undefined, 'local');
      const entry: Entry = { mandate, status: 'pending', promise: Promise.resolve('0x' as Hex) };
      entry.promise = (async () => {
        await registerSubname(label, owner);
        const r = await writeText(ensName, encodeMandateRecords(mandate));
        if (r.status !== 'success') throw new Error(`mandate write for ${ensName} reverted: ${r.hash}`);
        entry.status = 'confirmed';
        entry.txHash = r.hash;
        mandate.source = 'ens';
        log(`mandate on-chain ${ensName} ${r.hash}`);
        for (const cb of cbs) {
          try {
            cb(ensName, r.hash);
          } catch (e) {
            log(`onConfirmed callback threw: ${errorText(e).slice(0, 120)}`);
          }
        }
        return r.hash;
      })().catch((e) => {
        entry.status = 'failed';
        entry.error = errorText(e).slice(0, 300);
        log(`mandate write FAILED for ${ensName}: ${entry.error} — serving the local copy (source=local)`);
        throw e;
      });
      entry.promise.catch(() => {}); // observed later via whenConfirmed(); never an unhandled rejection
      entries.set(key, entry);
      return copy(mandate, await resolvedPayees(mandate));
    },

    async get(ensName) {
      const key = ensName.toLowerCase();
      const entry = entries.get(key);
      if (entry && entry.status !== 'confirmed') return copy(entry.mandate, await resolvedPayees(entry.mandate));
      const records = await readRecords(ensName, Object.values(MANDATE_KEYS));
      const parsed = parseMandateRecords(records);
      if (!parsed) {
        if (entry) return copy(entry.mandate, await resolvedPayees(entry.mandate));
        throw new Error(`no mandate for ${ensName} on ENSv2 Sepolia`);
      }
      const label = labelOf(ensName);
      let owner: Address = entry?.mandate.owner ?? zeroAddress;
      if (label) {
        try {
          const lay = await layout();
          const o = await pc.readContract({ address: lay.userRegistry, abi: registryAbi, functionName: 'findOwner', args: [label] });
          if (o !== zeroAddress) owner = o;
        } catch (e) {
          log(`findOwner(${label}) failed: ${errorText(e).slice(0, 100)}`);
        }
      }
      const payees = await Promise.all(parsed.payees.map(async (ens) => ({ ens, address: (await src.resolve(ens)) ?? zeroAddress })));
      return { ensName, owner, payees, perTxCapUsd: parsed.perTxCapUsd, dailyCapBps: parsed.dailyCapBps, expiresAt: parsed.expiresAt, source: 'ens' };
    },

    async resolve(ensName) {
      const key = ensName.toLowerCase();
      const hit = resolveCache.get(key);
      if (hit && Date.now() - hit.at < resolveTtl) return hit.address;
      try {
        const address = await pc.getEnsAddress({ name: key, universalResolverAddress: ENSV2.universalResolver });
        resolveCache.set(key, { at: Date.now(), address: address ?? null });
        return address ?? null;
      } catch (e) {
        log(`resolve(${ensName}) failed: ${errorText(e).slice(0, 120)}`);
        return hit?.address ?? null;
      }
    },

    async proveAgentCannotEdit(ensName, opts = {}) {
      const label = labelOf(ensName) ?? ensName;
      const agent = agentAccountFor(label, cfg.agentSeed);
      try {
        const { resolver } = await layout();
        return await proveEac({ publicClient: pc, resolver, ensName, agent, agentAccount: agent, relayer, send: opts.send, fund: opts.fund, key: opts.key });
      } catch (e) {
        return { rejected: false, detail: `proof could not run: ${errorText(e).slice(0, 200)}` };
      }
    },

    status: (ensName) => entries.get(ensName.toLowerCase())?.status ?? 'unknown',
    whenConfirmed(ensName) {
      const e = entries.get(ensName.toLowerCase());
      if (!e) return Promise.reject(new Error(`no pending write for ${ensName}`));
      return e.promise;
    },
    onConfirmed: (cb) => {
      cbs.push(cb);
    },
  };

  async function resolvedPayees(m: Mandate) {
    return Promise.all(m.payees.map(async (p) => ({ ens: p.ens, address: (await src.resolve(p.ens)) ?? p.address })));
  }
  return src;
}

const copy = (m: Mandate, payees: Mandate['payees']): Mandate => ({ ...m, payees });
