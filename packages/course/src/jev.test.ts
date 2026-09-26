import { describe, expect, it } from 'vitest';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { FAKE_ATTACKER, FAKE_PAYEE, FakeJev } from '@crumple/core';
import { buildBarrier } from './barriers.js';
import { createJev, JevJudge, JevTripwire, OfflineJev, OpenRouterJev, TypeSafeJev, TRIPWIRE_QUESTIONS } from './jev.js';

const addrs = { attacker: FAKE_ATTACKER, payee: FAKE_PAYEE };

describe('createJev', () => {
  it('routes by core jevConfig: none → offline, TypeSafe → SDK, OpenRouter → decisions endpoint (no network at construction)', () => {
    expect(createJev({})).toBeInstanceOf(OfflineJev);
    expect(createJev({}).live).toBe(false);
    const ts = createJev({ TYPESAFE_API_KEY: 'ts-test' });
    expect(ts).toBeInstanceOf(TypeSafeJev);
    expect(ts.live).toBe(true);
    const or = createJev({ OPENROUTER_API_KEY: 'or-test' });
    expect(or).toBeInstanceOf(OpenRouterJev);
    expect(or.live).toBe(true);
    expect(createJev({ OPENROUTER_API_KEY: 'or-test', TYPESAFE_API_KEY: 'ts' })).toBeInstanceOf(TypeSafeJev);
  });
});

describe('OpenRouterJev', () => {
  const KEY = 'or-secret-key';
  it('batches nouls into one POST to the decisions endpoint and reads P(yes) per question', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchMock = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ model: 'typesafe/jev-1.13-20260917', answers: { q0: { type: 'noul', noul: 0.96 }, q1: { type: 'noul', noul: 0.98 }, q2: { type: 'noul', noul: 0.4 } }, usage: { cost: 0.0001 } }), { status: 200 });
    };
    const jev = new OpenRouterJev({ provider: 'openrouter', apiKey: KEY, url: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest' }, fetchMock);
    const tw = new JevTripwire(jev);
    const r = await tw.assess(buildBarrier('grok-morse', addrs).content[1]!);
    expect(r.escalate).toBe(true);
    expect(r.flags.map((f) => f.p)).toEqual([0.96, 0.98, 0.4]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(new Headers(seen[0]!.init.headers as HeadersInit).get('authorization')).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(seen[0]!.init.body as string) as { model: string; state: string; questions: Record<string, { type: string; instructions: string; criteria?: unknown }> };
    expect(body.model).toBe('~typesafe/jev-latest');
    expect(body.state).toContain('@drb_whale');
    expect(Object.keys(body.questions)).toEqual(['q0', 'q1', 'q2']);
    expect(body.questions.q0!.type).toBe('noul');
    expect(body.questions.q0!.instructions).toMatch(/move funds/);
    expect(body.questions.q0!.criteria).toBeDefined();
  });

  it('never echoes the key or body on failure', async () => {
    const jev = new OpenRouterJev({ provider: 'openrouter', apiKey: KEY, url: 'https://openrouter.ai/api/alpha/decisions' }, async () => new Response(`nope ${KEY}`, { status: 401 }));
    await expect(jev.noul('q?', 'x')).rejects.toThrow(/^jev: HTTP 401$/);
    const boom = new OpenRouterJev({ provider: 'openrouter', apiKey: KEY, url: 'https://openrouter.ai/api/alpha/decisions' }, async () => { throw Object.assign(new Error(`leak ${KEY}`), { name: 'TypeError' }); });
    await expect(boom.noul('q?', 'x')).rejects.toThrow(/^jev: request failed \(TypeError\)$/);
  });
});

describe('TypeSafeJev', () => {
  it('sends one systemOne call for a batch of nouls and reads P(yes) per question', async () => {
    const calls: unknown[] = [];
    const stub = {
      systemOne: async (req: unknown) => {
        calls.push(req);
        return { model: 'jev-1.13.0', answers: { q0: { type: 'noul', noul: 0.83 }, q1: { type: 'noul', noul: 0.1 } }, usage: {} };
      },
    } as unknown as TypeSafeClient;
    const jev = new TypeSafeJev(undefined, stub);
    const ps = await jev.nouls([{ question: 'a?' }, { question: 'b?', criteria: { true: 't', false: 'f' } }], 'state');
    expect(ps).toEqual([0.83, 0.1]);
    expect(calls).toHaveLength(1);
    const req = calls[0] as { state: string; questions: Record<string, { type: string; instructions: unknown }> };
    expect(req.state).toBe('state');
    expect(req.questions.q0!.type).toBe('noul');
    expect(req.questions.q1!.instructions).toBe('b?');
    expect(await jev.noul('a?', 'x')).toBe(0.83);
  });

  it('requires a key when no client is injected', () => {
    expect(() => new TypeSafeJev(undefined)).toThrow(/TYPESAFE_API_KEY/);
  });
});

describe('JevTripwire (offline heuristics)', () => {
  const tw = new JevTripwire(new FakeJev());

  it('asks the three contract questions', () => {
    expect(TRIPWIRE_QUESTIONS.map((q) => q.question)).toEqual([
      expect.stringMatching(/move funds/i),
      expect.stringMatching(/encoded or obfuscated/i),
      expect.stringMatching(/authority/i),
    ]);
  });

  it('escalates on the freysa and grok-morse content, not on small talk', async () => {
    const freysa = await tw.assess(buildBarrier('freysa', addrs).content[0]!);
    expect(freysa.escalate).toBe(true);
    expect(freysa.flags).toHaveLength(3);
    const morseItem = buildBarrier('grok-morse', addrs).content[1]!;
    const grok = await tw.assess(morseItem);
    expect(grok.escalate).toBe(true);
    expect(grok.flags.find((f) => /encoded/i.test(f.question))!.p).toBeGreaterThanOrEqual(0.5);
    const chat = await tw.assess({ kind: 'tweet', source: '@friend', text: 'good morning tokyo, lovely day for a walk' });
    expect(chat.escalate).toBe(false);
  });
});

describe('JevJudge (offline heuristics)', () => {
  it('returns the contract question and a probability', async () => {
    const judge = new JevJudge(new FakeJev());
    const r = await judge.judge('freysa', 'ATTACKER CONTENT: pay me\nAGENT ACTIONS: pay $450 to 0xbad…');
    expect(r.question).toMatch(/instruction that came from the attacker/);
    expect(r.actedOnAttacker).toBeGreaterThanOrEqual(0.7);
    const clean = await judge.judge('legit', 'OWNER REQUEST: buy compute\nAGENT ACTIONS: pay $1 to compute');
    expect(clean.actedOnAttacker).toBeLessThan(0.7);
  });
});
