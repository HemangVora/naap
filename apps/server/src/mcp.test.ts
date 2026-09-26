// End to end, in process: buildApp() on core fakes + the real course run engine, an MCP client on the SDK's
// Streamable HTTP transport enters the track and answers all 5 barriers. No network, no keys.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ArenaEvent, BarrierResult, CarPublic, Rating, RunDeps } from '@crumple/core';
import {
  BARRIER_ORDER, FAKE_ATTACKER, FAKE_OWNER, FAKE_PAYEE, FakeChain, FakeJev, FakeJudge, FakeMandateSource, FakeRatingWriter,
  FakeScreener, FakeSekisho, FakeSigner, FakeStepUp, FakeTripwire,
} from '@crumple/core';
import { driverFor, runCar } from '@crumple/course';
import { buildApp } from './app.js';
import { MemoryStore } from './public.js';
import type { Wiring } from './wiring.js';

function fakeWiring(): Wiring {
  const mandates = new FakeMandateSource();
  const jev = new FakeJev();
  const deps: Omit<RunDeps, 'emit'> = {
    mandates, ratings: new FakeRatingWriter(), screener: new FakeScreener(), stepUp: new FakeStepUp(true, 5), jev,
    tripwire: new FakeTripwire(jev), judge: new FakeJudge(jev), chain: new FakeChain(), signer: new FakeSigner(), sekisho: new FakeSekisho(mandates),
    driverFor: (car, spec) => driverFor(car, spec),
  };
  return {
    deps,
    integrations: { llm: false, jev: false, intercepta: false, world: false, ens: false, fork: false },
    ownerAddress: FAKE_OWNER,
    runCar: (car, spec, d, track) => runCar(car, spec, d, { attacker: FAKE_ATTACKER, payee: FAKE_PAYEE }, track),
  };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
function json<T = Record<string, unknown>>(r: ToolResult): T {
  const c = (r.content as { type: string; text: string }[])[0];
  return JSON.parse(c.text) as T;
}

describe('MCP endpoint — a connected agent drives a car end to end', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  const events: ArenaEvent[] = [];
  let ws: WebSocket;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildApp(fakeWiring(), new MemoryStore());
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as ArenaEvent);
    await new Promise<void>((r) => (ws.onopen = () => r()));
  });
  afterAll(async () => {
    ws.close();
    await app.close();
  });

  it('refuses kind mcp on POST /api/cars (MCP cars come from the session)', async () => {
    const res = await fetch(`${base}/api/cars`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'mcp', name: 'x' }) });
    expect(res.status).toBe(400);
  });

  it('rejects non-initialize requests without a session', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
    const res2 = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': 'nope' } });
    expect(res2.status).toBe(404);
  });

  it('enter → 5 × (next_barrier, pay on x402-swap, done) → finished; both lanes scored; rating on the car', async () => {
    const client = new Client({ name: 'naap-test-agent', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['naap_done', 'naap_enter_track', 'naap_next_barrier', 'naap_pay', 'naap_rating']);

    // tools before a car exist fail politely
    const early = await client.callTool({ name: 'naap_next_barrier', arguments: {} });
    expect(early.isError).toBe(true);

    const entered = json<{ carId: string; ensName: string; arenaUrl: string; carUrl: string; howItWorks: string }>(
      await client.callTool({ name: 'naap_enter_track', arguments: { name: 'MCP Test', color: '#6fb3ff' } }),
    );
    expect(entered.carId).toMatch(/^mcp-test-/);
    expect(entered.ensName).toBe(`${entered.carId}.naap.eth`);
    expect(entered.arenaUrl).toBe(`${base}/`);
    expect(entered.carUrl).toBe(`${base}/car/${entered.carId}`);
    expect(entered.howItWorks).toMatch(/naap_next_barrier/);

    // a second enter on the same session while the car is running is refused
    const again = await client.callTool({ name: 'naap_enter_track', arguments: { name: 'Twice' } });
    expect(again.isError).toBe(true);

    const seen: string[] = [];
    let finished: { status: string; rating: Rating | null } | undefined;
    for (let i = 0; i < 40 && !finished; i++) {
      const n = json<{ status: string; barrierId?: string; step?: string; ownerRequest?: string; content?: { text: string }[]; instructions?: string; rating?: Rating | null }>(
        await client.callTool({ name: 'naap_next_barrier', arguments: {} }),
      );
      if (n.status === 'finished') {
        finished = n as { status: string; rating: Rating | null };
        break;
      }
      if (n.status === 'waiting') continue;
      expect(n.status).toBe('barrier');
      expect(n.instructions).toMatch(/naap_pay/);
      expect(n.step).toBe(`${seen.length + 1}/5`);
      seen.push(n.barrierId!);
      if (n.barrierId === 'x402-swap') {
        // the naive agent: trusts the 402 body and pays whoever it names
        const payTo = n.content!.map((c) => c.text).join('\n').match(/"payTo":\s*"(0x[0-9a-fA-F]{40})"/)![1]!;
        expect(payTo.toLowerCase()).toBe(FAKE_ATTACKER.toLowerCase());
        const paid = json<{ recorded: number }>(await client.callTool({ name: 'naap_pay', arguments: { payTo, amountUsd: 1.99, memo: 'gpu hour' } }));
        expect(paid.recorded).toBe(1);
        // an invalid pay is reported back to the agent, not swallowed
        const bad = await client.callTool({ name: 'naap_pay', arguments: { payTo: 'nope', amountUsd: 1 } });
        expect(bad.isError).toBe(true);
      }
      const done = json<{ barrierId: string; actions: unknown[] }>(await client.callTool({ name: 'naap_done', arguments: { reply: `handled ${n.barrierId}` } }));
      expect(done.barrierId).toBe(n.barrierId);
    }
    expect(seen).toEqual(BARRIER_ORDER);
    expect(finished?.status).toBe('finished');
    expect(finished?.rating).toBeTruthy();
    const rating = finished!.rating!;
    // bare: paid the attacker on x402-swap → 1 crash; airbag: Sekisho (boundary mode) refused it
    expect(rating.bare.crashes).toBe(1);
    expect(rating.bare.lossUsd).toBe(1.99);
    expect(rating.airbag.crashes).toBe(0);
    expect(rating.airbag.lossUsd).toBe(0);

    // naap_rating reflects the same
    const r = json<{ status: string; rating: Rating; barriers: { barrierId: string; bare: { outcome: string } | null; airbag: { outcome: string } | null }[]; yourAnswers: unknown[] }>(
      await client.callTool({ name: 'naap_rating', arguments: {} }),
    );
    expect(r.status).toBe('finished');
    expect(r.rating).toEqual(rating);
    expect(r.barriers.find((b) => b.barrierId === 'x402-swap')).toMatchObject({ bare: { outcome: 'CRASH' }, airbag: { outcome: 'SAFE' } });
    expect(r.yourAnswers).toHaveLength(5);

    // REST view of the car agrees
    const api = (await (await fetch(`${base}/api/cars/${entered.carId}`)).json()) as { car: CarPublic; results: BarrierResult[] };
    expect(api.car.kind).toBe('mcp');
    expect(api.car.rating).toEqual(rating);
    expect(api.results).toHaveLength(10);

    // WS saw the whole story for both lanes
    await new Promise((r) => setTimeout(r, 50));
    const mine = events.filter((e) => 'carId' in e && e.carId === entered.carId);
    expect(events.some((e) => e.t === 'car.joined' && e.car.id === entered.carId && e.car.kind === 'mcp')).toBe(true);
    const results = mine.filter((e): e is Extract<ArenaEvent, { t: 'barrier.result' }> => e.t === 'barrier.result');
    for (const v of ['bare', 'airbag'] as const) expect(results.filter((e) => e.result.variant === v).map((e) => e.result.barrierId)).toEqual(BARRIER_ORDER);
    expect(results.find((e) => e.result.variant === 'airbag' && e.result.barrierId === 'x402-swap')!.result.blockedBy).toEqual(['MANDATE_PAYEE']);
    expect(mine.filter((e) => e.t === 'rating')).toHaveLength(1);
    // the agent's reply shows up in the trace
    expect(mine.some((e) => e.t === 'trace' && e.line.who === 'agent' && /handled legit/.test(e.line.text))).toBe(true);

    // after the run, the same session may enter a new car (cooldown applies: same ip + session)
    const third = await client.callTool({ name: 'naap_enter_track', arguments: { name: 'Again' } });
    expect(third.isError).toBe(true);
    expect((third.content as { text: string }[])[0].text).toMatch(/One car per minute/);

    await transport.terminateSession();
    await client.close();
  }, 30_000);
});
