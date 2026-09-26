// Verdict mapping: raw Intercepta (Web3 Antivirus) responses → PASS / HOLD / BLOCK.
// Pure functions, no I/O. Thresholds are documented in docs/lanes/intercepta.md.
import type { ScreenResult } from '@crumple/core';

// ─── Raw response shapes (from https://docs.web3antivirus.io/reference/*.md, verified 2026-09-26) ──

/** GET /api/public/v2/extension/account/{address}/quick-scan → ToxicScoreShortResponseV2 */
export interface QuickScanResponse {
  toxicScore: number;
  traits: QuickScanTrait[];
}
export interface QuickScanTrait {
  risk: number;
  name: QuickScanTraitName | string;
  txsCount: number;
  description: string;
}
export type QuickScanTraitName =
  | 'known_scammer'
  | 'initiator_scam_transactions'
  | 'sanction_address_communication'
  | 'suspicious_dex_pair_deployer'
  | 'suspicious_deployer'
  | 'attack_money_target'
  | 'zero_address_risk'
  | 'sanction_address'
  | 'fake_phishing_transfer'
  | 'non_kyc_transfers'
  | 'mixer_transfers'
  | 'fake_phishing_contract_communication'
  | 'rug_pull'
  | 'rug_pull_trader'
  | 'blacklist';

/** GET /api/public/v2/extension/token-intelligence/token/{address}/risks?chainId= → TokenRiskAnalysisV2Response */
export interface ScanTokenResponse {
  apiVersion?: string;
  saleTax?: { currentValue: number; minValue: number; maxValue: number };
  buyTax?: { currentValue: number; minValue: number; maxValue: number };
  riskScore?: number; // a percentage
  riskLevel?: 'neutral' | 'low' | 'medium' | 'high';
  category?: 'malicious' | 'restricted' | 'suspicious' | 'availability' | 'sanctioned' | 'unverified' | 'info';
  trust?: 'whitelist' | 'blocklist' | 'neutral';
  action?: 'block' | 'warn' | 'info';
  detectors?: { code: string; description: string }[];
  token?: { chainId: string; address: string; symbol: string };
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

export type Verdict = ScreenResult['verdict'];

export interface Thresholds {
  /** toxicScore ≥ block → BLOCK (0–100 scale) */
  block: number;
  /** toxicScore ≥ hold → HOLD */
  hold: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { block: 70, hold: 30 };

/** Any of these traits, at any score, is a BLOCK on its own: the address itself is the bad actor or is sanctioned. */
export const BLOCK_TRAITS: ReadonlySet<string> = new Set<QuickScanTraitName>([
  'known_scammer',
  'initiator_scam_transactions',
  'sanction_address',
  'blacklist',
  'fake_phishing_transfer',
  'rug_pull',
  'attack_money_target',
]);

/** Exposure / association traits: HOLD on their own (an owner should look before money moves). */
export const HOLD_TRAITS: ReadonlySet<string> = new Set<QuickScanTraitName>([
  'sanction_address_communication',
  'mixer_transfers',
  'non_kyc_transfers',
  'fake_phishing_contract_communication',
  'suspicious_deployer',
  'suspicious_dex_pair_deployer',
  'rug_pull_trader',
  'zero_address_risk',
]);

const RANK: Record<Verdict, number> = { PASS: 0, HOLD: 1, BLOCK: 2 };
function worst(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The docs say toxicScore is a number; the extension shows 0–100. If a 0<x<1 fraction ever comes back, scale it. */
export function normaliseScore(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 0 && n < 1) return n * 100;
  return Math.min(100, n);
}

export interface Mapped {
  verdict: Verdict;
  toxicScore: number;
  traits: { name: string; description: string }[];
}

/**
 * Quick Scan mapping (documented in docs/lanes/intercepta.md):
 *  1. any BLOCK_TRAITS trait → BLOCK
 *  2. else toxicScore ≥ 70 → BLOCK; ≥ 30 → HOLD
 *  3. else any HOLD_TRAITS trait → HOLD
 *  4. else PASS
 * Traits are returned sorted by `risk` desc so `traits[0].description` is the headline reason.
 */
export function mapQuickScan(raw: QuickScanResponse, t: Thresholds = DEFAULT_THRESHOLDS): Mapped {
  const score = normaliseScore(raw?.toxicScore);
  const traits = [...(Array.isArray(raw?.traits) ? raw.traits : [])]
    .filter((x) => x && typeof x === 'object')
    .sort((a, b) => (Number(b.risk) || 0) - (Number(a.risk) || 0));

  let verdict: Verdict = 'PASS';
  if (traits.some((x) => BLOCK_TRAITS.has(String(x.name)))) verdict = 'BLOCK';
  if (score >= t.block) verdict = worst(verdict, 'BLOCK');
  else if (score >= t.hold) verdict = worst(verdict, 'HOLD');
  if (traits.some((x) => HOLD_TRAITS.has(String(x.name)))) verdict = worst(verdict, 'HOLD');

  return {
    verdict,
    toxicScore: score,
    traits: traits.map((x) => ({ name: String(x.name), description: String(x.description ?? x.name ?? '') })),
  };
}

/**
 * Scan Token mapping: Intercepta already gives an `action`, so we honour it:
 *  action block | trust blocklist | riskLevel high → BLOCK
 *  action warn  | riskLevel medium | category ∈ {suspicious, unverified, restricted} → HOLD
 *  otherwise → PASS. toxicScore = riskScore (already a %).
 */
export function mapScanToken(raw: ScanTokenResponse): Mapped {
  const score = normaliseScore(raw?.riskScore ?? 0);
  let verdict: Verdict = 'PASS';
  if (raw?.action === 'block' || raw?.trust === 'blocklist' || raw?.riskLevel === 'high') verdict = 'BLOCK';
  else if (
    raw?.action === 'warn' ||
    raw?.riskLevel === 'medium' ||
    raw?.category === 'suspicious' ||
    raw?.category === 'unverified' ||
    raw?.category === 'restricted'
  )
    verdict = 'HOLD';
  const detectors = Array.isArray(raw?.detectors) ? raw.detectors : [];
  return {
    verdict,
    toxicScore: score,
    traits: detectors.map((d) => ({ name: String(d.code), description: String(d.description ?? d.code) })),
  };
}

/** Headline reason for the scoreboard: first trait description, else a score line. */
export function reasonOf(r: Pick<ScreenResult, 'verdict' | 'toxicScore' | 'traits'>): string {
  const first = r.traits[0]?.description;
  if (first) return first;
  if (r.verdict === 'PASS') return `Intercepta: no risk traits (toxicScore ${r.toxicScore})`;
  return `Intercepta: toxicScore ${r.toxicScore}`;
}
