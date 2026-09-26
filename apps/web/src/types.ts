// Type-only imports from the frozen core interface. `import type` is erased by the
// bundler, so none of packages/core (incl. fakes.ts) ends up in the browser bundle.
export type {
  ArenaEvent,
  BarrierId,
  BarrierOutcome,
  BarrierResult,
  CarPublic,
  CarSpec,
  CheckResult,
  Control,
  Hex,
  Integrations,
  Rating,
  StepUpResult,
  TraceLine,
  Variant,
} from '@crumple/core';

import type { BarrierId, Control } from '@crumple/core';

/** Mirrors core BARRIER_ORDER (a value import would pull core's index into the bundle). */
export const BARRIERS: BarrierId[] = ['legit', 'grok-morse', 'freysa', 'x402-swap', 'over-limit'];

export const BARRIER_LABEL: Record<BarrierId, string> = {
  legit: 'LEGIT',
  'grok-morse': 'GROK MORSE',
  freysa: 'FREYSA',
  'x402-swap': 'X402 SWAP',
  'over-limit': 'OVER LIMIT',
};

export const BARRIER_SHORT: Record<BarrierId, string> = {
  legit: 'Legit',
  'grok-morse': 'Grok Morse',
  freysa: 'Freysa',
  'x402-swap': 'x402 swap',
  'over-limit': 'Over limit',
};

/** Colour family per control, used by chips in the HUD, plaques and phone pages. */
export const CONTROL_TONE: Record<Control, 'vermilion' | 'yellow' | 'amber' | 'blue'> = {
  TAINT: 'vermilion',
  PROVENANCE_PAYEE: 'vermilion',
  PROVENANCE_AMOUNT: 'vermilion',
  MANDATE_PAYEE: 'yellow',
  MANDATE_EXPIRED: 'yellow',
  CAP_TX: 'amber',
  CAP_DAILY: 'amber',
  JEV_TRIPWIRE: 'blue',
  INTERCEPTA: 'blue',
  WORLD_DENIED: 'amber',
  WORLD_EXPIRED: 'amber',
};

export const PALETTE = {
  charcoal: '#0d0e11',
  concrete: '#2a2c31',
  yellow: '#f5c400',
  vermilion: '#e2412b',
  green: '#3ddc97',
  amber: '#ffb020',
  text: '#f2efe8',
} as const;

export const ETHERSCAN_TX = 'https://sepolia.etherscan.io/tx/';

export const fmtUsd = (n: number) =>
  n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2).replace(/\.00$/, '')}`;

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
