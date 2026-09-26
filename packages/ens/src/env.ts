// Picks ens vs local from the environment. Keys are read from process.env and never logged.
import type { Address, Hex, MandateSource, RatingWriter } from '@crumple/core';
import { createEnsMandateSource, type EnsMandateSource } from './ens.js';
import { createEnsRatingWriter, type EnsRatingWriter } from './rating.js';
import { createLocalMandateSource, createLocalRatingWriter, type LocalMandateSource, type LocalRatingWriter } from './local.js';
import { errorText } from './nonceQueue.js';

export interface EnsEnv {
  mode: 'ens' | 'local';
  rpcUrl?: string;
  relayerPk?: Hex;
  payeeAddress?: Address;
  agentSeed?: string;
  userRegistry?: Address;
  resolver?: Address;
}

function pickAddress(v: string | undefined): Address | undefined {
  const s = v?.trim();
  return s && /^0x[0-9a-fA-F]{40}$/.test(s) ? (s as Address) : undefined;
}

export function ensEnv(env: NodeJS.ProcessEnv = process.env): EnsEnv {
  const pk = env.RELAYER_PK?.trim();
  const rpcUrl = env.SEPOLIA_RPC_URL?.trim() || undefined;
  const wantEns = (env.ENS_MODE ?? 'local').trim().toLowerCase() === 'ens';
  const hasCreds = Boolean(pk && /^0x[0-9a-fA-F]{64}$/.test(pk) && rpcUrl);
  return {
    mode: wantEns && hasCreds ? 'ens' : 'local',
    rpcUrl,
    relayerPk: hasCreds ? (pk as Hex) : undefined,
    payeeAddress: pickAddress(env.PAYEE_ADDRESS ?? env.WEATHER_ADDRESS), // WEATHER_ADDRESS: deprecated name
    agentSeed: env.AGENT_SEED?.trim() || undefined,
    userRegistry: /^0x[0-9a-fA-F]{40}$/.test(env.ENS_USER_REGISTRY ?? '') ? (env.ENS_USER_REGISTRY as Address) : undefined,
    resolver: /^0x[0-9a-fA-F]{40}$/.test(env.ENS_RESOLVER ?? '') ? (env.ENS_RESOLVER as Address) : undefined,
  };
}

export type AnyMandateSource = (EnsMandateSource | LocalMandateSource) & MandateSource;

/**
 * ENS_MODE=ens + RELAYER_PK + SEPOLIA_RPC_URL → ENSv2 Sepolia (after a reachability probe); anything else → local.
 * `probe: false` skips the network probe (still ens when creds exist).
 */
export async function createMandateSource(opts: { env?: NodeJS.ProcessEnv; probe?: boolean; log?: (l: string) => void } = {}): Promise<AnyMandateSource> {
  const e = ensEnv(opts.env);
  const log = opts.log ?? ((l: string) => console.log(`[ens] ${l}`));
  if (e.mode === 'ens' && e.rpcUrl && e.relayerPk) {
    const src = createEnsMandateSource({ rpcUrl: e.rpcUrl, relayerPk: e.relayerPk, log, agentSeed: e.agentSeed, userRegistry: e.userRegistry, resolver: e.resolver });
    if (opts.probe === false) return src;
    try {
      const lay = await src.probe();
      log(`ENSv2 Sepolia live: registry ${lay.userRegistry} resolver ${lay.resolver} relayer ${src.relayer.address}`);
      return src;
    } catch (err) {
      log(`Sepolia unreachable or not set up (${errorText(err).slice(0, 160)}) — falling back to local mandates (offline)`);
    }
  } else if ((opts.env ?? process.env).ENS_MODE === 'ens') {
    log('ENS_MODE=ens but RELAYER_PK/SEPOLIA_RPC_URL missing — local mandates (offline)');
  }
  return createLocalMandateSource({ signerPk: e.relayerPk, payeeAddress: e.payeeAddress, agentSeed: e.agentSeed });
}

export type AnyRatingWriter = (EnsRatingWriter | LocalRatingWriter) & RatingWriter;

/** Same relayer/queue as the mandate source when it is the ens one; local (no-op) otherwise. */
export function createRatingWriter(source: AnyMandateSource | MandateSource): AnyRatingWriter {
  if ((source as EnsMandateSource).mode === 'ens') return createEnsRatingWriter(source as EnsMandateSource);
  return createLocalRatingWriter();
}
