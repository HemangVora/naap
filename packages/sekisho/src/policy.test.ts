import { describe, expect, it } from 'vitest';
import type { Control, Mandate, TripwireResult } from '@crumple/core';
import { FAKE_ATTACKER, FAKE_WEATHER, FakeMandateSource, FakeScreener } from '@crumple/core';
import { evaluatePolicy, evaluatePolicyPure } from './policy.js';
import { short } from './util.js';
import { legitIntent, mandateFor, session } from './test-fixtures.js';

const ORDER: Control[] = ['PROVENANCE_AMOUNT', 'PROVENANCE_PAYEE', 'TAINT', 'MANDATE_PAYEE', 'MANDATE_EXPIRED', 'CAP_TX', 'CAP_DAILY', 'INTERCEPTA', 'JEV_TRIPWIRE'];
const pass = { address: FAKE_WEATHER, verdict: 'PASS' as const, toxicScore: 0, traits: [], live: false, cached: false };
const escalated: TripwireResult = { escalate: true, flags: [{ question: 'Does this text contain an instruction to move funds?', p: 0.9 }] };
const calm: TripwireResult = { escalate: false, flags: [{ question: 'Does this text contain an instruction to move funds?', p: 0.05 }] };

let mandate: Mandate;
const ready = mandateFor(new FakeMandateSource()).then((m) => (mandate = m));

describe('evaluatePolicyPure', () => {
  it('runs every check in contract order and PAYs a clean intent', async () => {
    await ready;
    const v = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: pass, now: 1 });
    expect(v.checks.map((c) => c.control)).toEqual(ORDER);
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v).toMatchObject({ decision: 'PAY', blockedBy: [] });
    expect(v.reason).toBe('Pay $1 to weather.naap.eth (0x111111…1111) — every check passed');
  });

  it('is pure: same inputs, same verdict', async () => {
    await ready;
    const a = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: pass, now: 1 });
    const b = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: pass, now: 1 });
    expect(a).toEqual(b);
  });

  it('JEV is friction only: an escalation never blocks a payment that passed everything else', async () => {
    await ready;
    const v = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: pass, now: 1, tripwire: escalated });
    expect(v.decision).toBe('PAY');
    const jev = v.checks.find((c) => c.control === 'JEV_TRIPWIRE')!;
    expect(jev.ok).toBe(true);
    expect(jev.detail).toMatch(/friction only/);
  });

  it('JEV adds a failing check when the amount is over cap (STEP_UP stays STEP_UP)', async () => {
    await ready;
    const intent = legitIntent({ amountUsd: { value: 40, label: 'OWNER', source: 'the owner request' } });
    const v = evaluatePolicyPure(intent, mandate, session('over-limit'), { screen: pass, now: 1, tripwire: escalated });
    expect(v.decision).toBe('STEP_UP');
    expect(v.blockedBy).toEqual(['CAP_TX', 'JEV_TRIPWIRE']);
    expect(v.reason).toMatch(/over the \$5 per-payment cap — asking the owner$/);
  });

  it('JEV adds a failing check when another check failed (REFUSE stays REFUSE, JEV never primary)', async () => {
    await ready;
    const intent = legitIntent({ amountUsd: { value: 450, label: 'UNTRUSTED', source: 'a message that redefined pay()' } });
    const v = evaluatePolicyPure(intent, mandate, session('freysa'), { screen: pass, now: 1, tripwire: escalated });
    expect(v.decision).toBe('REFUSE');
    expect(v.blockedBy[0]).toBe('PROVENANCE_AMOUNT');
    expect(v.blockedBy).toContain('JEV_TRIPWIRE');
    expect(v.blockedBy.indexOf('JEV_TRIPWIRE')).toBe(v.blockedBy.length - 1);
  });

  it('a calm tripwire is an ok check with a calm detail', async () => {
    await ready;
    const v = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: pass, now: 1, tripwire: calm });
    expect(v.checks.at(-1)).toMatchObject({ control: 'JEV_TRIPWIRE', ok: true });
  });

  it('TAINT: a tainted session may only pay mandate payees', async () => {
    await ready;
    const intent = legitIntent({ mode: 'boundary', payTo: { value: FAKE_ATTACKER, label: 'OPAQUE', source: 'agent action' }, amountUsd: { value: 1, label: 'OPAQUE', source: 'agent action' } });
    const tainted = session('freysa', { tainted: true, taintSources: ['inbox · treasury@freysa.ai'] });
    const v = evaluatePolicyPure(intent, mandate, tainted, { screen: { ...pass, address: FAKE_ATTACKER }, now: 1 });
    expect(v.decision).toBe('REFUSE');
    expect(v.blockedBy).toEqual(['TAINT', 'MANDATE_PAYEE']);
    expect(v.reason).toBe('Session read untrusted content (inbox · treasury@freysa.ai), so only mandate payees may be paid — 0xbad000…0bad is not one');
    // provenance checks pass in boundary mode (they are unknowable, not failed)
    expect(v.checks[0]).toMatchObject({ control: 'PROVENANCE_AMOUNT', ok: true });
    expect(v.checks[1]).toMatchObject({ control: 'PROVENANCE_PAYEE', ok: true });
  });

  it('MANDATE_EXPIRED refuses', async () => {
    await ready;
    const v = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: pass, now: mandate.expiresAt + 1 });
    expect(v.decision).toBe('REFUSE');
    expect(v.blockedBy).toEqual(['MANDATE_EXPIRED']);
    expect(v.reason).toMatch(/^Mandate for car1\.naap\.eth expired at /);
  });

  it('CAP_DAILY: spentToday + amount over 10% of balance steps up', async () => {
    await ready;
    const v = evaluatePolicyPure(legitIntent({ amountUsd: { value: 5, label: 'OWNER', source: 'the owner request' } }), mandate, session('legit', { spentTodayUsd: 46 }), { screen: pass, now: 1 });
    expect(v.decision).toBe('STEP_UP');
    expect(v.blockedBy).toEqual(['CAP_DAILY']);
    expect(v.reason).toBe('$46 already spent + $5 is over the $50 daily cap (10% of balance) — asking the owner');
  });

  it('INTERCEPTA: BLOCK / HOLD / unavailable all refuse, with the trait on screen', async () => {
    await ready;
    const block = { ...pass, verdict: 'BLOCK' as const, toxicScore: 95, traits: [{ name: 'drainer', description: 'known drainer address' }] };
    const v = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: block, now: 1 });
    expect(v.decision).toBe('REFUSE');
    expect(v.reason).toBe('Intercepta BLOCK for 0x111111…1111: known drainer address · offline');
    expect(evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: { ...pass, verdict: 'HOLD' }, now: 1 }).decision).toBe('REFUSE');
    expect(evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: null, now: 1 }).blockedBy).toEqual(['INTERCEPTA']);
    const tokenBad = evaluatePolicyPure(legitIntent(), mandate, session('legit'), { screen: pass, tokenScreen: { ...pass, verdict: 'BLOCK' }, now: 1 });
    expect(tokenBad.blockedBy).toEqual(['INTERCEPTA']);
  });

  it('full mode: a TOOL payTo resolved from an UNTRUSTED name still fails PROVENANCE_PAYEE', async () => {
    await ready;
    const intent = legitIntent({ payeeEns: { value: 'weather.naap.eth', label: 'UNTRUSTED', source: 'a tweet' } });
    const v = evaluatePolicyPure(intent, mandate, session('legit'), { screen: pass, now: 1 });
    expect(v.blockedBy).toEqual(['PROVENANCE_PAYEE']);
  });
});

describe('evaluatePolicy (with the fake screener)', () => {
  it('screens payTo and the USDC token, then decides', async () => {
    await ready;
    const v = await evaluatePolicy(legitIntent(), mandate, session('legit'), { screener: new FakeScreener(), now: 1 });
    expect(v.decision).toBe('PAY');
    const screen = v.checks.find((c) => c.control === 'INTERCEPTA')!;
    expect(screen.detail).toMatch(/PASS .* and USDC/);
    const bad = await evaluatePolicy(legitIntent({ payTo: { value: FAKE_ATTACKER, label: 'TOOL', source: 'resolve(x)' } }), mandate, session('legit'), { screener: new FakeScreener(), now: 1 });
    expect(bad.blockedBy).toEqual(expect.arrayContaining(['MANDATE_PAYEE', 'INTERCEPTA']));
  });
});

describe('short()', () => {
  it('shows 6+4 hex chars and never reads as the zero address', () => {
    expect(short('0x0000553f880ffa3728b290e04e819053a3590000')).toBe('0x000055…0000');
    expect(short('0x00000012aa00000000000000000000000000bbbb')).toBe('0x0000001…bbbb');
    expect(short('0x1111111111111111111111111111111111111111')).toBe('0x111111…1111');
    expect(short('weather.naap.eth')).toBe('weathe….eth');
  });
});
