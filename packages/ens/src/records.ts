// Pure helpers: names, ids, and the text-record encoding of mandates and ratings. No network.
import { keccak256, stringToBytes, toHex, type Hex } from 'viem';
import { namehash, normalize, packetToBytes } from 'viem/ens';
import { DEFAULT_MANDATE, INCIDENT_ENS_KEYS, MANDATE_KEYS, PARENT_ENS, RATING_KEYS, type Address, type Mandate, type Rating } from '@crumple/core';

export const PARENT_LABEL = PARENT_ENS.replace(/\.eth$/, ''); // "naap" by default

export interface TextRecord {
  key: string;
  value: string;
}

/** Make a car id a valid ENS label: lowercase, [a-z0-9-], 1–63 chars. Deterministic. */
export function toLabel(carId: string): string {
  const s = carId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!s) throw new Error(`carId "${carId}" has no label-safe characters`);
  return normalize(s);
}

export function carEnsName(carId: string): string {
  return `${toLabel(carId)}.${PARENT_ENS}`;
}

/** `<label>.<parent>` → label, or null when the name is not directly under the parent. */
export function labelOf(ensName: string): string | null {
  const n = ensName.toLowerCase();
  const suffix = `.${PARENT_ENS}`;
  if (!n.endsWith(suffix)) return null;
  const label = n.slice(0, -suffix.length);
  return label && !label.includes('.') ? label : null;
}

/** DNS-encoded name, as PermissionedResolver setters and the UniversalResolver expect. */
export function dnsName(name: string): Hex {
  return toHex(packetToBytes(name));
}

/** LibLabel.id(label) = uint256(keccak256(bytes(label))) — the registry `anyId`. */
export function labelId(label: string): bigint {
  return BigInt(keccak256(stringToBytes(label)));
}

/** PermissionedResolverLib.resource(string key) = uint256(keccak256(bytes(key))). */
export function resolverResource(key: string): bigint {
  return BigInt(keccak256(stringToBytes(key)));
}

export const node = (name: string): Hex => namehash(name);

/** Every text key the relayer writes; `register` grants ROLE_SET_TEXT for each (incident keys: inc-<id>.naap.eth). */
export const ALL_TEXT_KEYS: readonly string[] = [...Object.values(MANDATE_KEYS), ...Object.values(RATING_KEYS), ...Object.values(INCIDENT_ENS_KEYS)];

// ─── Mandate ────────────────────────────────────────────────────────────────

export function defaultMandateFor(carId: string, owner: Address, nowSec = Math.floor(Date.now() / 1000), source: Mandate['source'] = 'local'): Mandate {
  return {
    ensName: carEnsName(carId),
    owner,
    payees: DEFAULT_MANDATE.payees.map((ens) => ({ ens, address: '0x0000000000000000000000000000000000000000' as Address })),
    perTxCapUsd: DEFAULT_MANDATE.perTxCapUsd,
    dailyCapBps: DEFAULT_MANDATE.dailyCapBps,
    expiresAt: nowSec + DEFAULT_MANDATE.ttlSec,
    source,
  };
}

export function encodeMandateRecords(m: Pick<Mandate, 'payees' | 'perTxCapUsd' | 'dailyCapBps' | 'expiresAt'>): TextRecord[] {
  return [
    { key: MANDATE_KEYS.payees, value: m.payees.map((p) => p.ens.toLowerCase()).join(',') },
    { key: MANDATE_KEYS.perTxCapUsd, value: numStr(m.perTxCapUsd) },
    { key: MANDATE_KEYS.dailyCapBps, value: String(Math.round(m.dailyCapBps)) },
    { key: MANDATE_KEYS.expiresAt, value: String(Math.floor(m.expiresAt)) },
  ];
}

export interface ParsedMandate {
  payees: string[];
  perTxCapUsd: number;
  dailyCapBps: number;
  expiresAt: number;
}

/** Inverse of encodeMandateRecords. Returns null when the payees record is missing (no mandate written). */
export function parseMandateRecords(records: Record<string, string | null | undefined>): ParsedMandate | null {
  const payeesRaw = records[MANDATE_KEYS.payees];
  if (!payeesRaw) return null;
  const payees = payeesRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const perTxCapUsd = Number(records[MANDATE_KEYS.perTxCapUsd]);
  const dailyCapBps = Number(records[MANDATE_KEYS.dailyCapBps]);
  const expiresAt = Number(records[MANDATE_KEYS.expiresAt]);
  if (!payees.length || !Number.isFinite(perTxCapUsd) || !Number.isFinite(dailyCapBps) || !Number.isFinite(expiresAt)) {
    throw new Error(`malformed mandate records: ${JSON.stringify(records)}`);
  }
  return { payees, perTxCapUsd, dailyCapBps, expiresAt };
}

// ─── Rating ─────────────────────────────────────────────────────────────────

export function encodeRatingRecords(r: Rating, runAtSec = Math.floor(Date.now() / 1000)): TextRecord[] {
  const stars = Math.max(0, Math.min(5, Math.round(r.stars)));
  return [
    { key: RATING_KEYS.stars, value: String(stars) },
    { key: RATING_KEYS.lossBareUsd, value: numStr(r.bare.lossUsd) },
    { key: RATING_KEYS.lossAirbagUsd, value: numStr(r.airbag.lossUsd) },
    { key: RATING_KEYS.summary, value: ratingSummary(r) },
    { key: RATING_KEYS.runAt, value: String(Math.floor(runAtSec)) },
  ];
}

export function ratingSummary(r: Rating): string {
  const c = (s: number) => `${Math.max(0, Math.min(5, Math.round(s)))}/5`;
  return `bare ${c(r.bare.stars)} · airbag ${c(r.airbag.stars)}`;
}

export function parseRatingRecords(records: Record<string, string | null | undefined>): Rating | null {
  const stars = records[RATING_KEYS.stars];
  if (!stars) return null;
  const summary = records[RATING_KEYS.summary] ?? '';
  const m = /bare (\d)\/5 · airbag (\d)\/5/.exec(summary);
  const bareStars = m ? Number(m[1]) : Number(stars);
  const airbagStars = m ? Number(m[2]) : Number(stars);
  return {
    stars: Number(stars),
    bare: { stars: bareStars, lossUsd: Number(records[RATING_KEYS.lossBareUsd] ?? 0), crashes: -1 },
    airbag: { stars: airbagStars, lossUsd: Number(records[RATING_KEYS.lossAirbagUsd] ?? 0), crashes: -1 },
  };
}

function numStr(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
