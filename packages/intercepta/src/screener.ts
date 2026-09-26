// Intercepta (Web3 Antivirus) Screener — the live call that decides the payment.
//
//   Quick Scan  GET {base}/api/public/v2/extension/account/{address}/quick-scan
//   Scan Token  GET {base}/api/public/v2/extension/token-intelligence/token/{address}/risks?chainId=
//   Auth        X-API-KEY: <INTERCEPTA_API_KEY>
//
// Guarantees: one live request per address per process, address-keyed persistent cache, a hard request
// budget (default 900 of the 1,000-request sandbox), 5 s timeout, and `live:false` on every result that
// did not come from Intercepta (missing key, budget exhausted, timeout, HTTP error).
import type { Address, ScreenResult, Screener } from '@crumple/core';
import { FAKE_ATTACKER, FakeScreener } from '@crumple/core';
import { ATTACKERS } from './addresses.js';
import * as FX from './fixtures.js';
import { DEFAULT_THRESHOLDS, mapQuickScan, mapScanToken, reasonOf, type Mapped, type QuickScanResponse, type ScanTokenResponse, type Thresholds } from './mapping.js';
import { DEFAULT_CACHE_PATH, Store, readBudgetFile } from './store.js';

export const DEFAULT_BASE_URL = 'https://api.web3antivirus.io';
export const DEFAULT_BUDGET_CEILING = 900;
export const DEFAULT_TIMEOUT_MS = 5_000;

export const quickScanPath = (address: string) => `/api/public/v2/extension/account/${address}/quick-scan`;
export const scanTokenPath = (address: string, chainId: number) =>
  `/api/public/v2/extension/token-intelligence/token/${address}/risks?chainId=${chainId}`;

export interface ScreenerConfig {
  /** Defaults to process.env.INTERCEPTA_API_KEY. Empty → offline fake semantics (live:false). */
  apiKey?: string;
  baseUrl?: string;
  /** JSON file for the persistent cache + budget. `null` = memory only (tests). Default data/intercepta-cache.json. */
  cachePath?: string | null;
  /** Hard stop: once `used` reaches this, no more live requests are made. Default 900. */
  budgetCeiling?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  thresholds?: Thresholds;
  /** Addresses the offline fixture treats as flagged. Default: FAKE_ATTACKER + ATTACKERS. */
  knownBad?: Address[];
  now?: () => number;
}

export type ResultSource = 'live' | 'cache' | 'fixture' | 'fake';

export interface InterceptaScreenResult extends ScreenResult {
  /** live = fresh Intercepta response; cache = earlier Intercepta response (still live:true); fixture/fake = offline (live:false). */
  source: ResultSource;
  /** Headline for the scoreboard: first trait description. */
  reason: string;
  /** Path that was (or would have been) called — the README points judges here. */
  endpoint: string;
  ms: number;
  /** Why we are offline, when we are. Never contains the key. */
  error?: string;
}

export interface Budget {
  used: number;
  ceiling: number;
  remaining: number;
  hasKey: boolean;
  /** true when the next scan of an unseen address would be a real Intercepta call. */
  live: boolean;
  cachePath: string | null;
}

export interface InterceptaScreener extends Screener {
  quickScan(address: Address): Promise<InterceptaScreenResult>;
  scanToken(token: Address, chainId: number): Promise<InterceptaScreenResult>;
  budget(): Budget;
  readonly hasKey: boolean;
}

class TimeoutError extends Error {}

async function fetchJson(fetchImpl: typeof fetch, url: string, apiKey: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const timeout = new Promise<never>((_, reject) =>
    ac.signal.addEventListener('abort', () => reject(new TimeoutError(`timeout after ${timeoutMs} ms`)), { once: true }),
  );
  try {
    const res = await Promise.race([fetchImpl(url, { headers: { 'X-API-KEY': apiKey, accept: 'application/json' }, signal: ac.signal }), timeout]);
    const text = await Promise.race([res.text(), timeout]);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response: ${text.slice(0, 80)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

let lastCreated: InterceptaScreener | null = null;

export function createScreener(cfg: ScreenerConfig = {}): InterceptaScreener {
  const apiKey = (cfg.apiKey ?? process.env.INTERCEPTA_API_KEY ?? '').trim();
  const hasKey = apiKey.length > 0;
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const cachePath = cfg.cachePath === undefined ? DEFAULT_CACHE_PATH : cfg.cachePath;
  const ceiling = cfg.budgetCeiling ?? DEFAULT_BUDGET_CEILING;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const thresholds = cfg.thresholds ?? DEFAULT_THRESHOLDS;
  const now = cfg.now ?? (() => Date.now());
  const knownBad = new Set((cfg.knownBad ?? [FAKE_ATTACKER, ...ATTACKERS]).map((a) => a.toLowerCase()));
  const store = new Store(cachePath, ceiling);
  const fake = new FakeScreener(knownBad);

  // Per-process memo: the same address is never scanned twice. Failed (offline) results are not memoised so a
  // transient timeout can be retried on the next intent — still bounded by the budget.
  const inflight = new Map<string, Promise<InterceptaScreenResult>>();

  const finish = (
    address: Address,
    m: Mapped,
    extra: { live: boolean; cached: boolean; source: ResultSource; endpoint: string; ms: number; error?: string },
  ): InterceptaScreenResult => {
    const base = { address, verdict: m.verdict, toxicScore: m.toxicScore, traits: m.traits };
    return { ...base, ...extra, reason: reasonOf(base) };
  };

  const fixtureQuick = (address: Address): QuickScanResponse => (knownBad.has(address.toLowerCase()) ? FX.QUICK_SCAN_DRAINER : FX.QUICK_SCAN_CLEAN);
  const fixtureToken = (): ScanTokenResponse => FX.SCAN_TOKEN_USDC_BASE;

  async function viaFake(kind: 'quick' | 'token', address: Address, chainId: number, endpoint: string, t0: number) {
    void chainId; // FakeScreener.scanToken ignores the chain
    const r = kind === 'quick' ? await fake.quickScan(address) : await fake.scanToken(address);
    const m: Mapped = { verdict: r.verdict, toxicScore: r.toxicScore, traits: r.traits };
    return finish(address, m, { live: false, cached: false, source: 'fake', endpoint, ms: now() - t0, error: 'INTERCEPTA_API_KEY not set' });
  }

  async function run(kind: 'quick' | 'token', address: Address, chainId: number): Promise<InterceptaScreenResult> {
    const t0 = now();
    const endpoint = kind === 'quick' ? quickScanPath(address) : scanTokenPath(address, chainId);
    const hit = kind === 'quick' ? store.getQuick(address) : store.getToken(address, chainId);
    if (hit) {
      const m = kind === 'quick' ? mapQuickScan(hit.raw as QuickScanResponse, thresholds) : mapScanToken(hit.raw as ScanTokenResponse);
      return finish(address, m, { live: true, cached: true, source: 'cache', endpoint, ms: now() - t0 });
    }
    if (!hasKey) return viaFake(kind, address, chainId, endpoint, t0);

    const offline = (error: string) => {
      const m = kind === 'quick' ? mapQuickScan(fixtureQuick(address), thresholds) : mapScanToken(fixtureToken());
      return finish(address, m, { live: false, cached: false, source: 'fixture', endpoint, ms: now() - t0, error });
    };
    if (store.exhausted) return offline(`budget ceiling reached (${store.data.budget.used}/${store.data.budget.ceiling})`);

    store.spend(now());
    try {
      const raw = await fetchJson(fetchImpl, baseUrl + endpoint, apiKey, timeoutMs);
      let m: Mapped;
      if (kind === 'quick') {
        const q = raw as QuickScanResponse;
        if (!q || typeof q !== 'object' || (typeof q.toxicScore !== 'number' && !Array.isArray(q.traits))) throw new Error('unexpected quick-scan shape');
        m = mapQuickScan(q, thresholds);
        store.putQuick(address, { at: now(), raw, endpoint });
      } else {
        const s = raw as ScanTokenResponse;
        if (!s || typeof s !== 'object' || (s.action === undefined && s.riskLevel === undefined && s.riskScore === undefined)) throw new Error('unexpected scan-token shape');
        m = mapScanToken(s);
        store.putToken(address, chainId, { at: now(), raw, endpoint });
      }
      return finish(address, m, { live: true, cached: false, source: 'live', endpoint, ms: now() - t0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return offline(msg);
    }
  }

  function memo(key: string, kind: 'quick' | 'token', address: Address, chainId: number) {
    const existing = inflight.get(key);
    // A second caller gets the same Intercepta answer, flagged as cached (the result is still live:true).
    if (existing) return existing.then((r) => (r.live && !r.cached ? { ...r, cached: true, source: 'cache' as const, ms: 0 } : r));
    const p = run(kind, address, chainId).then((r) => {
      if (!r.live) inflight.delete(key);
      return r;
    });
    inflight.set(key, p);
    return p;
  }

  const screener: InterceptaScreener = {
    hasKey,
    quickScan: (address) => memo(`q:${Store.quickKey(address)}`, 'quick', address, 0),
    scanToken: (token, chainId) => memo(`t:${Store.tokenKey(token, chainId)}`, 'token', token, chainId),
    budget: () => ({
      used: store.data.budget.used,
      ceiling: store.data.budget.ceiling,
      remaining: store.remaining,
      hasKey,
      live: hasKey && !store.exhausted,
      cachePath,
    }),
  };
  lastCreated = screener;
  return screener;
}

/** Budget of the most recently created screener in this process, else whatever data/intercepta-cache.json says. */
export function budget(): Budget {
  if (lastCreated) return lastCreated.budget();
  const b = readBudgetFile(DEFAULT_CACHE_PATH, DEFAULT_BUDGET_CEILING);
  const hasKey = Boolean(process.env.INTERCEPTA_API_KEY?.trim());
  return { used: b.used, ceiling: b.ceiling, remaining: b.remaining, hasKey, live: hasKey && b.remaining > 0, cachePath: DEFAULT_CACHE_PATH };
}
