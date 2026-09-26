// Small pure helpers shared by every Sekisho stage. No I/O here.
import type { Address, TraceLine } from '@crumple/core';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

export function isAddress(s: unknown): s is Address {
  return typeof s === 'string' && ADDRESS_RE.test(s);
}
export function isEnsName(s: unknown): s is string {
  return typeof s === 'string' && ENS_RE.test(s);
}
export function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** "0x000055…0000" — 6 hex chars after 0x (more if they are all zeros, so a low address never reads as 0x0000…0000) and 4 at the end. */
export function short(addr: string): string {
  if (!addr) return '?';
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const hex = addr.slice(2);
  let n = 6;
  while (n < hex.length - 4 && /^0+$/.test(hex.slice(0, n))) n++;
  return `0x${hex.slice(0, n)}…${hex.slice(-4)}`;
}

/** Suffix the interpreter puts on an amount source when the text named no amount ("send ALL"). Policy keys off it. */
export const ASKED_FOR_EVERYTHING = ', which asked for everything';

/** "$1.00", "$450", "$1.99" */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '$?';
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** One line of text, capped, with any raw addresses removed so untrusted text can't smuggle one into a reason sentence. */
export function clean(s: unknown, max = 80): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/0x[0-9a-fA-F]{40}/g, '0x…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function trace(who: TraceLine['who'], text: string): TraceLine {
  return { at: Date.now(), who, text };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
