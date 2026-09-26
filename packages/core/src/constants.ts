export const PARENT_ENS = 'crumple.eth';
export const WEATHER_PAYEE_ENS = 'weather.crumple.eth';

/** Default mandate every car gets (CONTRACT.md §Mandate). */
export const DEFAULT_MANDATE = {
  payees: [WEATHER_PAYEE_ENS],
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
