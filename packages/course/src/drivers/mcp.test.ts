import { describe, expect, it, vi } from 'vitest';
import type { Observation } from '@crumple/core';
import { FAKE_ATTACKER, FAKE_PAYEE } from '@crumple/core';
import { McpDriver } from './mcp.js';
import { MAX_ACTIONS } from './sanitize.js';

const obs = (barrierId: Observation['barrierId'], runId = 'r'): Observation => ({
  runId, barrierId, ownerRequest: `owner asks at ${barrierId}`, content: [{ kind: 'web', source: 's', text: 't' }], tools: [],
});

describe('McpDriver — once per barrier across both lanes', () => {
  it('bare and airbag act() share one entry; the agent sees the barrier once and both lanes get the same actions', async () => {
    const d = new McpDriver({ timeoutMs: 5_000 });
    const bare = d.act(obs('legit', 'car-bare'));
    const airbag = d.act(obs('legit', 'car-airbag'));

    const next = await d.nextBarrier(100);
    expect(next.status).toBe('barrier');
    if (next.status !== 'barrier') throw new Error('unreachable');
    expect(next.barrierId).toBe('legit');
    expect(next.step).toBe(1);
    expect(next.total).toBe(5);
    expect(next.ownerRequest).toBe('owner asks at legit');
    expect(next.content).toHaveLength(1);

    d.pay({ payTo: FAKE_PAYEE, amountUsd: 1 });
    const done = d.done('bought it');
    expect(done.actions).toEqual([
      { type: 'pay', args: { payTo: FAKE_PAYEE, amountUsd: 1, token: 'USDC', memo: '' } },
      { type: 'reply', text: 'bought it' },
    ]);
    const [a, b] = await Promise.all([bare, airbag]);
    expect(a).toBe(b);
    expect(a).toEqual(done.actions);

    // a late second-lane call for an already answered barrier resolves immediately with the same actions
    expect(await d.act(obs('legit'))).toBe(a);
    // and the agent is NOT asked again
    expect((await d.nextBarrier(20)).status).toBe('waiting');
  });

  it('done with nothing recorded → noop; next_barrier while a barrier is open ends that turn (forgiving loop)', async () => {
    const d = new McpDriver({ timeoutMs: 5_000 });
    const p1 = d.act(obs('grok-morse'));
    expect((await d.nextBarrier(50)).status).toBe('barrier');
    expect(d.done().actions).toEqual([{ type: 'noop', reason: 'agent chose not to act' }]);
    expect(await p1).toEqual([{ type: 'noop', reason: 'agent chose not to act' }]);

    const p2 = d.act(obs('freysa'));
    expect((await d.nextBarrier(50)).status).toBe('barrier');
    const p3 = d.act(obs('x402-swap'));
    d.pay({ payTo: FAKE_ATTACKER, amountUsd: 450 });
    const n = await d.nextBarrier(50); // forgot naap_done → freysa settles with the recorded pay
    expect(n.status).toBe('barrier');
    if (n.status === 'barrier') expect(n.barrierId).toBe('x402-swap');
    expect((await p2).map((a) => a.type)).toEqual(['pay']);
    d.done();
    expect(await p3).toEqual([{ type: 'noop', reason: 'agent chose not to act' }]);
  });

  it('barriers are handed out in course order even when a lane is ahead', async () => {
    const d = new McpDriver({ timeoutMs: 5_000 });
    d.act(obs('legit'));
    d.act(obs('grok-morse'));
    const first = await d.nextBarrier(20);
    d.done();
    const second = await d.nextBarrier(20);
    expect([first, second].map((n) => (n.status === 'barrier' ? n.barrierId : n.status))).toEqual(['legit', 'grok-morse']);
  });
});

describe('McpDriver — timeout, waiting and finish', () => {
  it('times out → noop "agent timed out" for both lanes', async () => {
    vi.useFakeTimers();
    try {
      const d = new McpDriver({ timeoutMs: 90_000 });
      const bare = d.act(obs('freysa'));
      const airbag = d.act(obs('freysa'));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await bare).toEqual([{ type: 'noop', reason: 'agent timed out' }]);
      expect(await airbag).toEqual([{ type: 'noop', reason: 'agent timed out' }]);
      // the timed-out barrier is never offered to the agent afterwards
      const n = d.nextBarrier(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await n).status).toBe('waiting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('nextBarrier returns waiting when nothing is open, wakes on act(), and reports finished with the rating', async () => {
    const d = new McpDriver({ timeoutMs: 5_000 });
    expect(await d.nextBarrier(20)).toEqual({ status: 'waiting', detail: expect.stringMatching(/again/) });
    const pending = d.nextBarrier(2_000);
    setTimeout(() => d.act(obs('legit')), 10);
    const n = await pending;
    expect(n.status).toBe('barrier');
    d.done();
    const rating = { stars: 5, bare: { stars: 2, lossUsd: 451.99, crashes: 2 }, airbag: { stars: 5, lossUsd: 0, crashes: 0 } };
    setTimeout(() => d.finish(rating), 10);
    expect(await d.nextBarrier(2_000)).toEqual({ status: 'finished', rating, detail: 'run complete' });
    expect(d.isFinished).toBe(true);
    // a stray act() after finish is settled immediately
    expect(await d.act(obs('over-limit'))).toEqual([{ type: 'noop', reason: 'run ended' }]);
  });

  it('finish() while a barrier is open settles it with a noop so lanes never hang', async () => {
    const d = new McpDriver({ timeoutMs: 5_000 });
    const p = d.act(obs('legit'));
    d.finish(null);
    expect(await p).toEqual([{ type: 'noop', reason: 'run ended' }]);
    expect(await d.nextBarrier(10)).toEqual({ status: 'finished', rating: null, detail: 'run ended without a rating' });
  });
});

describe('McpDriver — pay validation', () => {
  it('rejects pay/done with no open barrier, bad payees, bad amounts, and caps the count', async () => {
    const d = new McpDriver({ timeoutMs: 5_000 });
    expect(() => d.pay({ payTo: FAKE_PAYEE, amountUsd: 1 })).toThrow(/naap_next_barrier first/);
    expect(() => d.done()).toThrow(/naap_next_barrier first/);
    d.act(obs('legit'));
    await d.nextBarrier(20);
    expect(() => d.pay({ payTo: 'not-an-address', amountUsd: 1 })).toThrow(/Invalid payment/);
    expect(() => d.pay({ payTo: FAKE_PAYEE, amountUsd: -1 })).toThrow(/Invalid payment/);
    expect(() => d.pay({ payTo: FAKE_PAYEE, amountUsd: 'abc' })).toThrow(/Invalid payment/);
    expect(() => d.pay(null)).toThrow(/Invalid payment/);
    // ENS names are lower-cased, amounts rounded to cents, token defaults to USDC, memo capped
    const r = d.pay({ payTo: 'Compute.NaAP.ETH', amountUsd: 1.239, memo: 'x'.repeat(300) });
    expect(r.action).toEqual({ type: 'pay', args: { payTo: 'compute.naap.eth', amountUsd: 1.24, token: 'USDC', memo: 'x'.repeat(200) } });
    for (let i = 1; i < MAX_ACTIONS; i++) d.pay({ payTo: FAKE_PAYEE, amountUsd: 1 });
    expect(() => d.pay({ payTo: FAKE_PAYEE, amountUsd: 1 })).toThrow(/At most/);
    expect(d.done().actions).toHaveLength(MAX_ACTIONS);
  });
});

describe('McpDriver — tracks that repeat a barrier type', () => {
  it('keys turns by step, so a repeated obstacle is asked again and reports step n/total from the track', async () => {
    const d = new McpDriver({ timeoutMs: 5_000 });
    const first = d.act({ ...obs('freysa'), step: 0, totalSteps: 3 });
    const n1 = await d.nextBarrier(100);
    if (n1.status !== 'barrier') throw new Error('expected a barrier');
    expect([n1.step, n1.total]).toEqual([1, 3]);
    d.done();
    await first;
    const second = d.act({ ...obs('freysa'), step: 2, totalSteps: 3 });
    const n2 = await d.nextBarrier(100);
    if (n2.status !== 'barrier') throw new Error('expected the repeated freysa');
    expect([n2.barrierId, n2.step, n2.total]).toEqual(['freysa', 3, 3]);
    d.done('no');
    expect(await second).toEqual([{ type: 'reply', text: 'no' }]);
    expect(d.answers().map((a) => a.step)).toEqual([1, 3]);
  });
});
