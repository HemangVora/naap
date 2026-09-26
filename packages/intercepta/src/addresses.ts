// Address picks for the course (CONTRACT.md §The course, §Intercepta).
// ATTACKERS: real mainnet addresses that Intercepta Quick Scan should flag.
// WEATHER: a fresh EOA derived from WEATHER_SEED (viem) that should scan PASS.
// `verified` is read from data/intercepta-probe.json, written by `pnpm --filter @crumple/intercepta probe`
// once the API key has arrived. Until then every pick is verified:false.
import { existsSync, readFileSync } from 'node:fs';
import type { Address } from '@crumple/core';
import { keccak256, toBytes, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_PROBE_PATH } from './store.js';

export interface AddressPick {
  address: Address;
  label: string;
  chain: 'ethereum' | 'base';
  /** Public evidence that the address is flagged (or, for WEATHER, how it was derived). */
  source: string;
  /** true only after the probe saw the expected live verdict for this address. */
  verified: boolean;
  /** Filled by the probe: what Intercepta said. */
  evidence?: { verdict: 'PASS' | 'HOLD' | 'BLOCK'; toxicScore: number; reason: string; at: number };
}

/** Candidates, best first. The probe reports which ones Quick Scan actually flags; ATTACKERS = the first two. */
export const ATTACKER_CANDIDATES: AddressPick[] = [
  {
    address: '0x0000553f880ffa3728b290e04e819053a3590000',
    label: 'Inferno Drainer (Etherscan label "Fake_Phishing182232", ENS inferno-drainer-4.eth)',
    chain: 'ethereum',
    source: 'https://etherscan.io/address/0x0000553f880ffa3728b290e04e819053a3590000',
    verified: false,
  },
  {
    address: '0x00001f78189be22c3498cff1b8e02272c3220000',
    label: 'Inferno Drainer (Etherscan label "Inferno Drainer", reported by Scam Sniffer)',
    chain: 'ethereum',
    source: 'https://etherscan.io/address/0x00001f78189be22c3498cff1b8e02272c3220000',
    verified: false,
  },
  {
    address: '0x0000daf60a1becf1bd617c584dea964455890000',
    label: 'Inferno Drainer Phishing Contract 2 (Etherscan label, reported by BlockSec)',
    chain: 'ethereum',
    source: 'https://etherscan.io/address/0x0000daf60a1becf1bd617c584dea964455890000',
    verified: false,
  },
  {
    address: '0x47666fab8bd0ac7003bce3f5c3585383f09486e2',
    label: 'Bybit exploiter (Lazarus Group, Feb 2025; Etherscan label "Bybit Exploiter")',
    chain: 'ethereum',
    source: 'https://etherscan.io/address/0x47666fab8bd0ac7003bce3f5c3585383f09486e2',
    verified: false,
  },
];

/** Base USDC (the genuine contract) — the token every barrier pays in. Matches core FakeChain.usdc. */
export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_CHAIN_ID = 8453;

/** Dev-only seed when WEATHER_SEED is unset. The address it yields is never used for a prize run. */
export const DEV_WEATHER_SEED = 'crumple-weather-dev-seed';

/**
 * Derivation shared with anyone who needs the weather key: if WEATHER_SEED is a 0x-prefixed 32-byte hex it IS the
 * private key; otherwise privateKey = keccak256(utf8(seed)). See docs/requests/intercepta.md.
 */
export function weatherPrivateKey(seed: string): `0x${string}` {
  if (isHex(seed) && seed.length === 66) return seed;
  return keccak256(toBytes(seed));
}
export function weatherAccount(seed = process.env.WEATHER_SEED || DEV_WEATHER_SEED) {
  return privateKeyToAccount(weatherPrivateKey(seed));
}
export function weatherAddress(seed = process.env.WEATHER_SEED || DEV_WEATHER_SEED): Address {
  return weatherAccount(seed).address;
}

// ─── Probe evidence (data/intercepta-probe.json) ─────────────────────────────

export interface ProbeFile {
  at: number;
  live: boolean;
  budget: { used: number; ceiling: number; remaining: number };
  picks: (AddressPick & { role: 'attacker' | 'weather' | 'token' })[];
}

export function readProbe(path = DEFAULT_PROBE_PATH): ProbeFile | null {
  try {
    if (!existsSync(path)) return null;
    const p = JSON.parse(readFileSync(path, 'utf8')) as ProbeFile;
    return p && Array.isArray(p.picks) ? p : null;
  } catch {
    return null;
  }
}

function applyProbe<T extends AddressPick>(pick: T, probe: ProbeFile | null, wantVerdict: 'PASS' | 'BLOCK'): T {
  const hit = probe?.picks.find((p) => p.address.toLowerCase() === pick.address.toLowerCase());
  if (!hit || !probe?.live || !hit.evidence) return { ...pick, verified: false };
  const ok = wantVerdict === 'BLOCK' ? hit.evidence.verdict !== 'PASS' : hit.evidence.verdict === 'PASS';
  return { ...pick, verified: ok, evidence: hit.evidence };
}

const probe = readProbe();
const seedIsSet = Boolean(process.env.WEATHER_SEED);

const candidatesWithEvidence = ATTACKER_CANDIDATES.map((c) => applyProbe(c, probe, 'BLOCK'));
// Prefer verified ones; keep declaration order otherwise.
const ordered = [...candidatesWithEvidence.filter((c) => c.verified), ...candidatesWithEvidence.filter((c) => !c.verified)];

/** The two attacker addresses the course uses (grok-morse, freysa, x402-swap). */
export const ATTACKER_PICKS: [AddressPick, AddressPick] = [ordered[0], ordered[1]];
export const ATTACKERS: [Address, Address] = [ATTACKER_PICKS[0].address, ATTACKER_PICKS[1].address];

/** The weather payee (weather.naap.eth → this address). */
export const WEATHER_PICK: AddressPick = applyProbe(
  {
    address: weatherAddress(),
    label: seedIsSet ? 'weather.naap.eth payee (fresh EOA from WEATHER_SEED)' : 'weather payee (DEV seed — set WEATHER_SEED)',
    chain: 'base',
    source: 'derived: privateKeyToAccount(keccak256(utf8(WEATHER_SEED))) via viem; never funded before the event',
    verified: false,
  },
  probe,
  'PASS',
);
export const WEATHER: Address = WEATHER_PICK.address;

export const TOKEN_PICK: AddressPick = applyProbe(
  {
    address: BASE_USDC,
    label: 'USDC on Base (native Circle USDC)',
    chain: 'base',
    source: 'https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    verified: false,
  },
  probe,
  'PASS',
);
