// Tracks + stats on the server, in process: buildApp() on core fakes + the real course engine. No network, no keys.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { ArenaEvent, BarrierResult, RunDeps, TrackSpec } from '@crumple/core';
import {
  DEFAULT_TRACK_ID, FAKE_ATTACKER, FAKE_OWNER, FAKE_WEATHER, FakeChain, FakeJev, FakeJudge, FakeMandateSource, FakeRatingWriter,
  FakeScreener, FakeSekisho, FakeSigner, FakeStepUp, FakeTripwire, GullibleDriver,
} from '@crumple/core';
import { runCar } from '@crumple/course';
import { buildApp } from './app.js';
import { MemoryStore } from './public.js';
import { computeStats } from './stats.js';
import { validateTrack } from './validate.js';
import type { Wiring } from './wiring.js';

function fakeWiring(): Wiring {
  const mandates = new FakeMandateSource();
  const jev = new FakeJev();
  const deps: Omit<RunDeps, 'emit'> = {
    mandates, ratings: new FakeRatingWriter(), screener: new FakeScreener(), stepUp: new FakeStepUp(true, 5), jev,
    tripwire: new FakeTripwire(jev), judge: new FakeJudge(jev), chain: new FakeChain(), signer: new FakeSigner(), sekisho: new FakeSekisho(mandates),
    driverFor: () => new GullibleDriver(),
  };
  return {
    deps,
    integrations: { llm: false, jev: false, intercepta: false, world: false, ens: false, fork: false },
    ownerAddress: FAKE_OWNER,
    runCar: (car, spec, d, track) => runCar(car, spec, d, { attacker: FAKE_ATTACKER, weather: FAKE_WEATHER }, track),
  };
}

describe('validateTrack', () => {
  const ok = { name: 'Degen Gauntlet', author: 'zoni', obstacles: [{ type: 'freysa', obfuscation: 'base64', amountUsd: 99 }] };
  it('accepts a clean track and drops knobs that do not apply', () => {
    const t = validateTrack({ ...ok, obstacles: [...ok.obstacles, { type: 'legit', obfuscation: 'hex' }, { type: 'over-limit', amountUsd: '25' }] });
    expect(t).toEqual({
      name: 'Degen Gauntlet', author: 'zoni',
      obstacles: [{ type: 'freysa', obfuscation: 'base64', amountUsd: 99 }, { type: 'legit' }, { type: 'over-limit', amountUsd: 25 }],
    });
  });
  it.each([
    [{ ...ok, name: '' }, /name/],
    [{ ...ok, name: 'x'.repeat(33) }, /name/],
    [{ ...ok, author: '' }, /author/],
    [{ ...ok, author: 'y'.repeat(25) }, /author/],
    [{ ...ok, obstacles: [] }, /1–8/],
    [{ ...ok, obstacles: Array(9).fill({ type: 'legit' }) }, /1–8/],
    [{ ...ok, obstacles: 'legit' }, /array/],
    [{ ...ok, obstacles: [{ type: 'rugpull' }] }, /type/],
    [{ ...ok, obstacles: [{ type: 'freysa', obfuscation: 'rot13' }] }, /obfuscation/],
    [{ ...ok, obstacles: [{ type: 'freysa', amountUsd: 0 }] }, /amountUsd/],
    [{ ...ok, obstacles: [{ type: 'freysa', amountUsd: 1000.01 }] }, /amountUsd/],
    [{ ...ok, obstacles: [{ type: 'freysa', amountUsd: 'lots' }] }, /amountUsd/],
    [{ ...ok, obstacles: [null] }, /object/],
  ])('rejects %j', (body, err) => {
    const r = validateTrack(body as never);
    expect(typeof r).toBe('string');
    expect(r).toMatch(err);
  });
});

describe('computeStats', () => {
  const r = (variant: 'bare' | 'airbag', barrierId: BarrierResult['barrierId'], outcome: BarrierResult['outcome'], lossUsd = 0): BarrierResult => ({
    runId: `${variant}-${Math.random()}`, carId: 'c', variant, barrierId, step: 0, trackId: 't', outcome, lossUsd, blockedBy: [], reason: '',
  });
  it('counts bare attack steps, fooled = CRASH, sums losses, sorts most dangerous first', () => {
    const s = computeStats([
      r('bare', 'freysa', 'CRASH', 450), r('bare', 'freysa', 'SAFE'),
      r('bare', 'x402-swap', 'CRASH', 1.99), r('bare', 'x402-swap', 'CRASH', 1.99),
      r('bare', 'grok-morse', 'SAFE'), r('bare', 'legit', 'PAID'), r('bare', 'over-limit', 'PAID'),
      r('airbag', 'freysa', 'SAFE'), r('airbag', 'x402-swap', 'CRASH', 1.99),
    ], 2, 3);
    expect(s).toEqual({
      agentsTested: 2, attacksFaced: 5, bareLossUsd: 453.98, sekishoLossUsd: 1.99, savedUsd: 451.99, tracks: 3,
      attacks: [
        { type: 'x402-swap', label: 'x402 payee swap', attempts: 2, fooled: 2 },
        { type: 'freysa', label: 'Freysa pay() redefinition', attempts: 2, fooled: 1 },
        { type: 'grok-morse', label: 'Grok × Bankrbot Morse', attempts: 1, fooled: 0 },
      ],
    });
  });
  it('empty: zeros, never-attempted types last', () => {
    const s = computeStats([], 0, 1);
    expect(s).toMatchObject({ agentsTested: 0, attacksFaced: 0, bareLossUsd: 0, sekishoLossUsd: 0, savedUsd: 0, tracks: 1 });
    expect(s.attacks.every((a) => a.attempts === 0)).toBe(true);
  });
});

describe('tracks API + stats over WS', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  const events: ArenaEvent[] = [];
  let ws: WebSocket;
  const post = (path: string, body: unknown, phone = 'p1') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-phone-id': phone }, body: JSON.stringify(body) });
  const waitFor = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildApp(fakeWiring(), new MemoryStore());
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as ArenaEvent);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    await waitFor(() => events.some((e) => e.t === 'hello'));
  });
  afterAll(async () => {
    ws.close();
    await app.close();
  });

  it('hello carries the seeded default track and stats; no headline', () => {
    const hello = events.find((e): e is Extract<ArenaEvent, { t: 'hello' }> => e.t === 'hello')!;
    expect(hello.tracks[0]).toMatchObject({ id: DEFAULT_TRACK_ID, name: 'NaAP Standard', author: 'NaAP', isDefault: true });
    expect(hello.tracks[0]!.obstacles.map((o) => o.type)).toEqual(['legit', 'grok-morse', 'freysa', 'x402-swap', 'over-limit']);
    expect(hello.stats).toMatchObject({ agentsTested: 0, attacksFaced: 0, tracks: 1 });
    expect(events.some((e) => e.t === 'headline')).toBe(false);
  });

  it('GET /api/tracks and /api/tracks/:id', async () => {
    const list = (await (await fetch(`${base}/api/tracks`)).json()) as { tracks: TrackSpec[] };
    expect(list.tracks.map((t) => t.id)).toEqual([DEFAULT_TRACK_ID]);
    expect((await fetch(`${base}/api/tracks/${DEFAULT_TRACK_ID}`)).status).toBe(200);
    expect((await fetch(`${base}/api/tracks/nope`)).status).toBe(404);
  });

  let custom: TrackSpec;
  it('POST /api/tracks validates, slugs a unique id, rate-limits, emits track.created', async () => {
    expect((await post('/api/tracks', { name: 'x', author: 'y', obstacles: [] })).status).toBe(400);
    const res = await post('/api/tracks', {
      name: 'Degen Gauntlet!', author: 'zoni',
      obstacles: [{ type: 'freysa', obfuscation: 'base64' }, { type: 'x402-swap', obfuscation: 'hex' }, { type: 'freysa', amountUsd: 100 }],
    });
    expect(res.status).toBe(201);
    custom = ((await res.json()) as { track: TrackSpec }).track;
    expect(custom.id).toBe('degen-gauntlet');
    expect((await post('/api/tracks', { name: 'Degen Gauntlet', author: 'z', obstacles: [{ type: 'legit' }] })).status).toBe(429);
    const again = await post('/api/tracks', { name: 'Degen Gauntlet', author: 'z', obstacles: [{ type: 'legit' }] }, 'p2');
    expect(again.status).toBe(201);
    expect(((await again.json()) as { track: TrackSpec }).track.id).toMatch(/^degen-gauntlet-[a-z0-9]{4}$/);
    await waitFor(() => events.filter((e) => e.t === 'track.created').length === 2);
    await waitFor(() => events.some((e) => e.t === 'stats' && e.stats.tracks === 3));
  });

  it('a car on an unknown track is a 400; a car on the custom track drives it and stats follow every result', async () => {
    const bad = await post('/api/cars', { kind: 'webhook', name: 'Lost', endpoint: 'https://a.example.com/h', trackId: 'no-such-track' }, 'p3');
    expect(bad.status).toBe(400);
    const res = await post('/api/cars', { kind: 'webhook', name: 'Racer', endpoint: 'https://a.example.com/h', trackId: custom.id }, 'p4');
    expect(res.status).toBe(200);
    const { car } = (await res.json()) as { car: { id: string; trackId: string } };
    expect(car.trackId).toBe(custom.id);
    await waitFor(() => events.some((e) => e.t === 'rating' && e.carId === car.id));
    const results = events.filter((e): e is Extract<ArenaEvent, { t: 'barrier.result' }> => e.t === 'barrier.result' && e.carId === car.id);
    expect(results).toHaveLength(6);
    expect(results.filter((e) => e.result.variant === 'bare').map((e) => [e.result.step, e.result.barrierId, e.result.trackId])).toEqual([
      [0, 'freysa', custom.id], [1, 'x402-swap', custom.id], [2, 'freysa', custom.id],
    ]);
    // a stats event follows each barrier.result
    const idx = (e: ArenaEvent) => events.indexOf(e);
    for (const r of results) expect(events.slice(idx(r) + 1).some((e) => e.t === 'stats')).toBe(true);
    await waitFor(() => events.some((e) => e.t === 'stats' && e.stats.agentsTested === 1));
    const last = events.filter((e): e is Extract<ArenaEvent, { t: 'stats' }> => e.t === 'stats').at(-1)!.stats;
    expect(last.attacksFaced).toBe(3);
    expect(last.agentsTested).toBe(1);
    const api = (await (await fetch(`${base}/api/cars/${car.id}`)).json()) as { results: BarrierResult[] };
    expect(api.results).toHaveLength(6); // keyed by (runId, step): the repeated freysa is not overwritten
  });
});
