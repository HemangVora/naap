import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_ATTACKER } from '@crumple/core';
import type { Address } from '@crumple/core';
import { budget, createScreener, quickScanPath, scanTokenPath } from './screener.js';
import { mapQuickScan, mapScanToken, reasonOf } from './mapping.js';
import { ATTACKERS, BASE_USDC, WEATHER, weatherAddress } from './addresses.js';
import * as FX from './fixtures.js';

const DRAINER = ATTACKERS[0];
const CLEAN: Address = '0x000000000000000000000000000000000000c1ea';
const OTHER: Address = '0x00000000000000000000000000000000000000ff';
const KEY = 'test-key-never-logged';

type Route = (url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
function mockFetch(route: Route) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const { status, body } = await route(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return Object.assign(f as unknown as typeof fetch, { calls });
}
const byPath: Route = (url) => {
  if (url.includes(quickScanPath(DRAINER))) return { status: 200, body: FX.QUICK_SCAN_DRAINER };
  if (url.includes('/quick-scan')) return { status: 200, body: FX.QUICK_SCAN_CLEAN };
  if (url.includes('/token-intelligence/')) return { status: 200, body: FX.SCAN_TOKEN_USDC_BASE };
  return { status: 404, body: { status: 404 } };
};

let dir: string;
let cachePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intercepta-'));
  cachePath = join(dir, 'cache.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('mapping', () => {
  it('drainer fixture → BLOCK with the first trait description as the reason', () => {
    const m = mapQuickScan(FX.QUICK_SCAN_DRAINER);
    expect(m.verdict).toBe('BLOCK');
    expect(m.toxicScore).toBe(100);
    expect(reasonOf({ verdict: m.verdict, toxicScore: m.toxicScore, traits: m.traits })).toMatch(/known scammer/i);
  });
  it('clean fixture → PASS', () => {
    expect(mapQuickScan(FX.QUICK_SCAN_CLEAN).verdict).toBe('PASS');
  });
  it('exposure traits → HOLD; score thresholds 30/70; block traits win at any score', () => {
    expect(mapQuickScan(FX.QUICK_SCAN_EXPOSURE).verdict).toBe('HOLD');
    expect(mapQuickScan({ toxicScore: 29, traits: [] }).verdict).toBe('PASS');
    expect(mapQuickScan({ toxicScore: 30, traits: [] }).verdict).toBe('HOLD');
    expect(mapQuickScan({ toxicScore: 70, traits: [] }).verdict).toBe('BLOCK');
    expect(mapQuickScan({ toxicScore: 5, traits: [{ risk: 5, name: 'sanction_address', txsCount: 1, description: 'OFAC' }] }).verdict).toBe('BLOCK');
    // a 0..1 fraction is scaled to 0..100
    expect(mapQuickScan({ toxicScore: 0.8, traits: [] }).toxicScore).toBe(80);
  });
  it('traits are sorted by risk so the headline is the worst one', () => {
    const m = mapQuickScan({
      toxicScore: 90,
      traits: [
        { risk: 10, name: 'non_kyc_transfers', txsCount: 1, description: 'minor' },
        { risk: 90, name: 'known_scammer', txsCount: 9, description: 'major' },
      ],
    });
    expect(m.traits[0].description).toBe('major');
  });
  it('token: action block → BLOCK, warn → HOLD, info → PASS', () => {
    expect(mapScanToken(FX.SCAN_TOKEN_FAKE_USDC).verdict).toBe('BLOCK');
    expect(mapScanToken(FX.SCAN_TOKEN_WARN).verdict).toBe('HOLD');
    const usdc = mapScanToken(FX.SCAN_TOKEN_USDC_BASE);
    expect(usdc.verdict).toBe('PASS');
    expect(usdc.traits[0].name).toBe('HIGH_REPUTATION_TOKEN');
  });
});

describe('createScreener (live, mocked fetch)', () => {
  it('calls the documented paths with X-API-KEY and maps the verdict', async () => {
    const f = mockFetch(byPath);
    const s = createScreener({ apiKey: KEY, fetch: f, cachePath });
    const bad = await s.quickScan(DRAINER);
    expect(bad).toMatchObject({ verdict: 'BLOCK', live: true, cached: false, source: 'live' });
    expect(bad.reason).toMatch(/known scammer/i);
    expect(f.calls[0].url).toBe(`https://api.web3antivirus.io${quickScanPath(DRAINER)}`);
    expect(f.calls[0].headers['X-API-KEY']).toBe(KEY);

    const ok = await s.quickScan(CLEAN);
    expect(ok).toMatchObject({ verdict: 'PASS', live: true });

    const tok = await s.scanToken(BASE_USDC, 8453);
    expect(tok).toMatchObject({ verdict: 'PASS', live: true, source: 'live' });
    expect(f.calls[2].url).toBe(`https://api.web3antivirus.io${scanTokenPath(BASE_USDC, 8453)}`);
    expect(s.budget()).toMatchObject({ used: 3, ceiling: 900, remaining: 897, hasKey: true, live: true });
  });

  it('cache hit avoids a second request (in-process, concurrent, and across processes via the JSON file)', async () => {
    const f = mockFetch(byPath);
    const s = createScreener({ apiKey: KEY, fetch: f, cachePath });
    const [a, b] = await Promise.all([s.quickScan(DRAINER), s.quickScan(DRAINER.toUpperCase().replace('0X', '0x') as Address)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a.verdict).toBe('BLOCK');
    expect(b.verdict).toBe('BLOCK');
    const again = await s.quickScan(DRAINER);
    expect(f).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ cached: true, live: true, source: 'cache' });

    // A fresh screener over the same file: served from disk, still live:true, budget carried over.
    const f2 = mockFetch(byPath);
    const s2 = createScreener({ apiKey: KEY, fetch: f2, cachePath });
    const c = await s2.quickScan(DRAINER);
    expect(f2).not.toHaveBeenCalled();
    expect(c).toMatchObject({ verdict: 'BLOCK', cached: true, live: true });
    expect(s2.budget().used).toBe(1);

    const file = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(file.quickScan[DRAINER.toLowerCase()].raw).toEqual(FX.QUICK_SCAN_DRAINER);
    expect(file.budget.used).toBe(1);
  });

  it('budget ceiling is a hard stop: falls back to fixture with live:false, cache still answers', async () => {
    const f = mockFetch(byPath);
    const s = createScreener({ apiKey: KEY, fetch: f, cachePath, budgetCeiling: 2 });
    await s.quickScan(CLEAN);
    await s.quickScan(OTHER);
    const third = await s.quickScan(DRAINER);
    expect(f).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({ live: false, source: 'fixture', verdict: 'BLOCK' });
    expect(third.error).toMatch(/budget ceiling/);
    expect(s.budget()).toMatchObject({ used: 2, remaining: 0, live: false });
    const cached = await s.quickScan(CLEAN);
    expect(cached).toMatchObject({ live: true, cached: true });
    expect(budget().used).toBe(2);
  });

  it('timeout → offline fixture (live:false), not cached, retried on the next call', async () => {
    let calls = 0;
    const slow = vi.fn((_: unknown, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    }) as unknown as typeof fetch;
    const s = createScreener({ apiKey: KEY, fetch: slow, cachePath, timeoutMs: 20 });
    const r = await s.quickScan(CLEAN);
    expect(r).toMatchObject({ live: false, source: 'fixture', verdict: 'PASS' });
    expect(r.error).toMatch(/timeout after 20 ms/);
    expect(s.budget().used).toBe(1);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).quickScan).toEqual({});
    await s.quickScan(CLEAN);
    expect(calls).toBe(2);
  });

  it('HTTP 403 (bad key) → offline, error text never contains the key', async () => {
    const f = mockFetch(() => ({ status: 403, body: FX.ERROR_403 }));
    const s = createScreener({ apiKey: KEY, fetch: f, cachePath });
    const r = await s.quickScan(DRAINER);
    expect(r).toMatchObject({ live: false, source: 'fixture', verdict: 'BLOCK' });
    expect(r.error).toMatch(/HTTP 403/);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('unexpected shape → offline', async () => {
    const f = mockFetch(() => ({ status: 200, body: { hello: 'world' } }));
    const s = createScreener({ apiKey: KEY, fetch: f, cachePath });
    const r = await s.quickScan(CLEAN);
    expect(r.live).toBe(false);
    expect(r.error).toMatch(/unexpected/);
  });
});

describe('no key → FakeScreener semantics', () => {
  it('blocks FAKE_ATTACKER and the real ATTACKERS, passes everything else, never touches fetch', async () => {
    const f = mockFetch(byPath);
    const s = createScreener({ apiKey: '', fetch: f, cachePath: null });
    expect(s.hasKey).toBe(false);
    expect(await s.quickScan(FAKE_ATTACKER)).toMatchObject({ verdict: 'BLOCK', live: false, source: 'fake' });
    expect(await s.quickScan(ATTACKERS[1])).toMatchObject({ verdict: 'BLOCK', live: false });
    expect(await s.quickScan(WEATHER)).toMatchObject({ verdict: 'PASS', live: false });
    expect(await s.scanToken(BASE_USDC, 8453)).toMatchObject({ verdict: 'PASS', live: false });
    expect(f).not.toHaveBeenCalled();
    expect(s.budget()).toMatchObject({ used: 0, hasKey: false, live: false });
  });
});

describe('addresses', () => {
  it('weather is a deterministic fresh EOA from the seed; attackers are distinct real addresses', () => {
    expect(weatherAddress('abc')).toBe(weatherAddress('abc'));
    expect(weatherAddress('abc')).not.toBe(weatherAddress('abd'));
    expect(weatherAddress('0x' + '11'.repeat(32))).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ATTACKERS[0]).not.toBe(ATTACKERS[1]);
    for (const a of ATTACKERS) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    expect(WEATHER).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
