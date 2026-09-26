// Local fallback: EIP-191-signed mandate JSON, in memory. Used when ENS_MODE=local or Sepolia is unreachable.
// The UI must show "offline" when this is in use (Mandate.source === 'local').
import { keccak256, stringToBytes, verifyMessage } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { FAKE_PAYEE, PAYEE_ENS, type Address, type Hex, type Mandate, type MandateSource, type Rating, type RatingWriter } from '@crumple/core';
import { carEnsName, defaultMandateFor, encodeMandateRecords, labelOf, short } from './records.js';

export interface LocalMandateConfig {
  /** Signing key (the relayer key when present). A throwaway key is generated when missing. */
  signerPk?: Hex;
  /** compute.naap.eth → this address. Defaults to FAKE_PAYEE. */
  payeeAddress?: Address;
  /** Extra name → address entries. */
  names?: Record<string, Address>;
  /** Seed for the agent key used in proveAgentCannotEdit (default 'crumple-agent'). */
  agentSeed?: string;
}

export interface SignedMandate {
  mandate: Mandate;
  /** EIP-191 signature over canonicalMandateJson(mandate) by `signer`. */
  signature: Hex;
  signer: Address;
}

export interface LocalMandateSource extends MandateSource {
  readonly mode: 'local';
  readonly signer: Address;
  /** The signed envelope, for the UI / debugging. */
  envelope(ensName: string): SignedMandate | undefined;
  /** Resolves immediately — nothing is pending in local mode. */
  whenConfirmed(ensName: string): Promise<null>;
  status(ensName: string): 'confirmed' | 'unknown';
  onConfirmed(cb: (ensName: string, txHash: Hex | null) => void): void;
}

/** Deterministic JSON so the signature is reproducible: sorted keys, no `source`, addresses lowercased. */
export function canonicalMandateJson(m: Mandate): string {
  const body = {
    dailyCapBps: m.dailyCapBps,
    ensName: m.ensName.toLowerCase(),
    expiresAt: m.expiresAt,
    owner: m.owner.toLowerCase(),
    payees: m.payees.map((p) => ({ address: p.address.toLowerCase(), ens: p.ens.toLowerCase() })),
    perTxCapUsd: m.perTxCapUsd,
    records: encodeMandateRecords(m),
  };
  return JSON.stringify(body);
}

export function agentAccountFor(carId: string, seed = 'crumple-agent') {
  return privateKeyToAccount(keccak256(stringToBytes(`${seed}:${carId}`)));
}

export function createLocalMandateSource(cfg: LocalMandateConfig = {}): LocalMandateSource {
  const account = privateKeyToAccount(cfg.signerPk ?? generatePrivateKey());
  const names = new Map<string, Address>([[PAYEE_ENS, cfg.payeeAddress ?? FAKE_PAYEE]]);
  for (const [k, v] of Object.entries(cfg.names ?? {})) names.set(k.toLowerCase(), v);
  const store = new Map<string, SignedMandate>();
  const cbs: ((ensName: string, txHash: Hex | null) => void)[] = [];

  async function sign(mandate: Mandate): Promise<SignedMandate> {
    const signature = await account.signMessage({ message: canonicalMandateJson(mandate) });
    return { mandate, signature, signer: account.address };
  }

  const src: LocalMandateSource = {
    mode: 'local',
    signer: account.address,
    async createForCar(carId, owner) {
      const m = defaultMandateFor(carId, owner, undefined, 'local');
      m.payees = await Promise.all(m.payees.map(async (p) => ({ ens: p.ens, address: (await src.resolve(p.ens)) ?? p.address })));
      const env = await sign(m);
      store.set(m.ensName.toLowerCase(), env);
      names.set(m.ensName.toLowerCase(), owner);
      queueMicrotask(() => cbs.forEach((cb) => cb(m.ensName, null)));
      return { ...m, payees: m.payees.map((p) => ({ ...p })) };
    },
    async get(ensName) {
      const env = store.get(ensName.toLowerCase());
      if (!env) throw new Error(`no mandate for ${ensName}`);
      const ok = await verifyMessage({ address: env.signer, message: canonicalMandateJson(env.mandate), signature: env.signature });
      if (!ok) throw new Error(`mandate for ${ensName} failed signature verification`);
      // Re-resolve payees at read time (never typed by anyone).
      const payees = await Promise.all(env.mandate.payees.map(async (p) => ({ ens: p.ens, address: (await src.resolve(p.ens)) ?? p.address })));
      return { ...env.mandate, payees, source: 'local' };
    },
    async resolve(ensName) {
      return names.get(ensName.toLowerCase()) ?? null;
    },
    async proveAgentCannotEdit(ensName) {
      const env = store.get(ensName.toLowerCase());
      if (!env) return { rejected: true, detail: `local mode: no mandate for ${ensName}` };
      const label = labelOf(ensName) ?? ensName;
      const agent = agentAccountFor(label, cfg.agentSeed);
      // The agent forges an edited mandate and signs it with its own key — verification against the relayer fails.
      const forged: Mandate = { ...env.mandate, perTxCapUsd: 9999 };
      const sig = await agent.signMessage({ message: canonicalMandateJson(forged) });
      const accepted = await verifyMessage({ address: env.signer, message: canonicalMandateJson(forged), signature: sig });
      return {
        rejected: !accepted,
        detail: accepted
          ? `UNEXPECTED: agent ${short(agent.address)} produced a signature the relayer check accepted`
          : `local mode (offline): agent ${short(agent.address)} signed an edited mandate (perTxCapUsd → 9999) but the store only accepts EIP-191 signatures from the relayer ${short(env.signer)} — edit rejected`,
      };
    },
    envelope: (ensName) => store.get(ensName.toLowerCase()),
    whenConfirmed: async () => null,
    status: (ensName) => (store.has(ensName.toLowerCase()) ? 'confirmed' : 'unknown'),
    onConfirmed: (cb) => {
      cbs.push(cb);
    },
  };
  return src;
}

export interface LocalRatingWriter extends RatingWriter {
  readonly mode: 'local';
  written: { carId: string; ensName: string; rating: Rating; at: number }[];
}

/** Offline rating writer: records in memory, never fires onConfirmed (there is no chain). */
export function createLocalRatingWriter(): LocalRatingWriter {
  const written: LocalRatingWriter['written'] = [];
  return {
    mode: 'local',
    written,
    enqueue(carId, ensName, rating) {
      written.push({ carId, ensName: ensName || carEnsName(carId), rating, at: Date.now() });
    },
    onConfirmed() {},
  };
}
