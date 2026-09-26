import { BARRIER_ORDER, DEFAULT_TRACK_ID, type TrackSpec } from './types.js';

/** The product's ENS parent. Every car is `<id>.<parent>`; the payee (a GPU compute seller) is `compute.<parent>`. */
export const DEFAULT_PARENT_ENS = 'naap.eth';

/**
 * ENS_PARENT (server/scripts only; browsers have no `process`) overrides the parent, e.g. `crumple.eth` for the
 * earlier deployment. Must be a single label under .eth.
 */
function parentFromEnv(): string | undefined {
  const raw = typeof process !== 'undefined' ? process.env?.ENS_PARENT?.trim().toLowerCase() : undefined;
  if (!raw) return undefined;
  if (!/^[a-z0-9-]{1,63}\.eth$/.test(raw)) throw new Error(`ENS_PARENT must look like "<label>.eth", got "${raw}"`);
  return raw;
}

export const PARENT_ENS: string = parentFromEnv() ?? DEFAULT_PARENT_ENS;
/** The one mandate payee: a GPU compute seller the car buys inference from over x402. */
export const PAYEE_ENS = `compute.${PARENT_ENS}`;
/** @deprecated Old name from when the payee sold weather reports; same value as PAYEE_ENS. */
export const WEATHER_PAYEE_ENS = PAYEE_ENS;

/** Default mandate every car gets (CONTRACT.md §Mandate). */
export const DEFAULT_MANDATE = {
  payees: [PAYEE_ENS],
  perTxCapUsd: 5,
  dailyCapBps: 1000, // 10% of balance
  ttlSec: 7 * 24 * 3600,
} as const;

/** Each car starts every barrier with this on the fork. */
export const CAR_START_BALANCE_USD = 500;

export const STEPUP_TTL_AUDIENCE_SEC = 60;
export const STEPUP_TTL_OWNER_SEC = 300;

/** Queue & guardrails (Q16). */
export const MAX_CONCURRENT_RUNS = 3;
export const RUN_COOLDOWN_PER_PHONE_SEC = 60;
export const REMOTE_STEP_TIMEOUT_MS = 10_000;

export const AUDIENCE_DEFAULT_MODEL = 'claude-haiku-4-5-20251001' as const;


/** The built-in five-incident track every car drives unless it picked another (seeded by the server). */
export const DEFAULT_TRACK: TrackSpec = {
  id: DEFAULT_TRACK_ID,
  name: 'NaAP Standard',
  author: 'NaAP',
  obstacles: BARRIER_ORDER.map((type) => ({ type })),
  createdAt: 0,
  isDefault: true,
};

/** Track builder limits (POST /api/tracks). */
export const TRACK_LIMITS = { nameMax: 32, authorMax: 24, minObstacles: 1, maxObstacles: 8, maxAmountUsd: 1000 } as const;
