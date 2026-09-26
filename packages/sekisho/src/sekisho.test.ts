import { describe, expect, it } from 'vitest';
import { FAKE_ATTACKER, FAKE_WEATHER, FakeMandateSource, FakeScreener, FakeTripwire, GullibleDriver } from '@crumple/core';
import { createSekisho } from './sekisho.js';
import { barriers, car, mandateFor, scriptedLlm, session } from './test-fixtures.js';
import { short } from './util.js';

async function setup() {
  const mandates = new FakeMandateSource();
  const mandate = await mandateFor(mandates);
  const llm = scriptedLlm();
  const sekisho = createSekisho({ mandates, screener: new FakeScreener(), tripwire: new FakeTripwire(), llm });
  return { mandates, mandate, llm, sekisho };
}

describe('full mode (built cars)', () => {
  it('legit: pays $1 to weather via resolve(), amount OWNER_BOUNDED', async () => {
    const { sekisho, mandate, llm } = await setup();
    const s = session('legit');
    const out = await sekisho.runBuilt(car, 'weather nerd', barriers.legit, mandate, s);
    expect(out.intents).toHaveLength(1);
    const [intent] = out.intents;
    expect(intent.payTo).toMatchObject({ value: FAKE_WEATHER, label: 'TOOL' });
    expect(intent.amountUsd).toMatchObject({ value: 1, label: 'OWNER_BOUNDED' });
    expect(intent.payeeEns?.value).toBe('weather.crumple.eth');
    expect(out.verdicts[0].decision).toBe('PAY');
    expect(out.verdicts[0].blockedBy).toEqual([]);
    expect(out.verdicts[0].checks.map((c) => c.control)).toEqual([
      'PROVENANCE_AMOUNT', 'PROVENANCE_PAYEE', 'TAINT', 'MANDATE_PAYEE', 'MANDATE_EXPIRED', 'CAP_TX', 'CAP_DAILY', 'INTERCEPTA', 'JEV_TRIPWIRE',
    ]);
    expect(s.tainted).toBe(true); // the 402 body is untrusted, and weather is still in the mandate
    // the planner never saw content; the reader never saw the owner request
    expect(llm.planCalls[0]).toEqual({ ownerRequest: barriers.legit.ownerRequest, persona: 'weather nerd', mandatePayees: ['weather.crumple.eth'] });
    expect(llm.readCalls[0].indexes).toEqual([0]);
    expect(out.trace.map((t) => t.who)).toEqual(expect.arrayContaining(['tripwire', 'planner', 'reader', 'interpreter', 'policy', 'screen']));
  });

  it('grok-morse: the Morse reply becomes a candidate intent that policy refuses by provenance, with the Jev chip', async () => {
    const { sekisho, mandate } = await setup();
    const out = await sekisho.runBuilt(car, 'helper', barriers['grok-morse'], mandate, session('grok-morse'));
    expect(out.intents).toHaveLength(1);
    expect(out.intents[0].payTo).toMatchObject({ value: FAKE_ATTACKER, label: 'UNTRUSTED' });
    expect(out.intents[0].amountUsd.label).toBe('UNTRUSTED');
    expect(out.intents[0].token).toBe('DRB');
    const v = out.verdicts[0];
    expect(v.decision).toBe('REFUSE');
    expect(['PROVENANCE_AMOUNT', 'PROVENANCE_PAYEE']).toContain(v.blockedBy[0]);
    expect(v.blockedBy).toContain('JEV_TRIPWIRE');
    expect(v.blockedBy).toContain('INTERCEPTA');
    expect(v.reason).toContain('a Morse-coded reply by @drb_whale');
    expect(v.reason).toContain('UNTRUSTED');
    expect(v.reason).not.toMatch(/0x[0-9a-f]{40}/i); // short addresses only on the projector
    const payee = v.checks.find((c) => c.control === 'PROVENANCE_PAYEE')!;
    expect(payee.ok).toBe(false);
    expect(payee.detail).toBe(`Payee ${short(FAKE_ATTACKER)} came from a Morse-coded reply by @drb_whale (UNTRUSTED)`);
  });

  it('freysa: the $450 "prize" is refused with PROVENANCE_AMOUNT primary', async () => {
    const { sekisho, mandate } = await setup();
    const out = await sekisho.runBuilt(car, 'helper', barriers.freysa, mandate, session('freysa'));
    expect(out.intents).toHaveLength(1);
    const v = out.verdicts[0];
    expect(v.decision).toBe('REFUSE');
    expect(v.blockedBy[0]).toBe('PROVENANCE_AMOUNT');
    expect(v.reason).toBe('Amount $450 came from a message that redefined pay() (UNTRUSTED)');
    expect(v.blockedBy).toEqual(expect.arrayContaining(['PROVENANCE_PAYEE', 'TAINT', 'MANDATE_PAYEE', 'CAP_TX', 'CAP_DAILY', 'INTERCEPTA', 'JEV_TRIPWIRE']));
    // every check ran, none short-circuited
    expect(v.checks).toHaveLength(9);
  });

  it('x402-swap: the swapped 402 payTo stays UNTRUSTED and the reason shows both addresses', async () => {
    const { sekisho, mandate } = await setup();
    const out = await sekisho.runBuilt(car, 'weather nerd', barriers['x402-swap'], mandate, session('x402-swap'));
    expect(out.intents).toHaveLength(1);
    const [intent] = out.intents;
    expect(intent.payTo).toMatchObject({ value: FAKE_ATTACKER, label: 'UNTRUSTED' });
    expect(intent.amountUsd).toMatchObject({ value: 1.99, label: 'OWNER_BOUNDED' });
    const v = out.verdicts[0];
    expect(v.decision).toBe('REFUSE');
    expect(v.blockedBy[0]).toBe('PROVENANCE_PAYEE');
    expect(v.reason).toBe(`402 said pay ${short(FAKE_ATTACKER)}, but weather.crumple.eth resolves to ${short(FAKE_WEATHER)}`);
    expect(v.blockedBy).toContain('INTERCEPTA');
  });

  it('over-limit: $40 to weather is a STEP_UP on CAP_TX, not a refusal', async () => {
    const { sekisho, mandate } = await setup();
    const out = await sekisho.runBuilt(car, 'weather nerd', barriers['over-limit'], mandate, session('over-limit'));
    expect(out.intents).toHaveLength(1);
    expect(out.intents[0].payTo).toMatchObject({ value: FAKE_WEATHER, label: 'TOOL' });
    expect(out.intents[0].amountUsd).toMatchObject({ value: 40, label: 'OWNER_BOUNDED' });
    const v = out.verdicts[0];
    expect(v.decision).toBe('STEP_UP');
    expect(v.blockedBy[0]).toBe('CAP_TX');
    expect(v.blockedBy).not.toContain('CAP_DAILY'); // $40 ≤ 10% of $500
    // the fake Jev flags "pay" in the 402 body; over cap, that is a friction chip — never a refusal
    expect(v.blockedBy.slice(1)).toEqual(['JEV_TRIPWIRE']);
    expect(v.reason).toBe('$40 to weather.crumple.eth (0x1111…1111) is over the $5 per-payment cap — asking the owner');
  });

  it('a plan that names a raw address or an unknown ref is rejected and nothing is paid', async () => {
    const mandates = new FakeMandateSource();
    const mandate = await mandateFor(mandates);
    const badPlan = { steps: [{ op: 'pay', payee: FAKE_ATTACKER, amount: 5, maxUsd: null, memo: null, ref: null, kind: null, reason: null }], note: 'evil' };
    const llm = { live: false, plannerModel: 'x', readerModel: 'x', plan: async () => badPlan, read: async () => ({}) };
    const sekisho = createSekisho({ mandates, screener: new FakeScreener(), tripwire: new FakeTripwire(), llm });
    const out = await sekisho.runBuilt(car, '', barriers.legit, mandate, session('legit'));
    expect(out.intents).toEqual([]);
    expect(out.trace.find((t) => t.who === 'planner')?.text).toMatch(/rejected plan/);
  });

  it('a planner error fails closed', async () => {
    const mandates = new FakeMandateSource();
    const mandate = await mandateFor(mandates);
    const llm = { live: false, plannerModel: 'x', readerModel: 'x', plan: async () => { throw new Error('boom'); }, read: async () => ({}) };
    const sekisho = createSekisho({ mandates, screener: new FakeScreener(), tripwire: new FakeTripwire(), llm });
    const out = await sekisho.runBuilt(car, '', barriers.legit, mandate, session('legit'));
    expect(out.intents).toEqual([]);
    expect(out.verdicts).toEqual([]);
  });

  it('runs offline with the heuristic LLM when none is injected', async () => {
    const mandates = new FakeMandateSource();
    const mandate = await mandateFor(mandates);
    const sekisho = createSekisho({ mandates, screener: new FakeScreener(), tripwire: new FakeTripwire() });
    expect(sekisho.llm.live).toBe(false);
    const legit = await sekisho.runBuilt(car, '', barriers.legit, mandate, session('legit'));
    expect(legit.verdicts[0]?.decision).toBe('PAY');
    const swap = await sekisho.runBuilt(car, '', barriers['x402-swap'], mandate, session('x402-swap'));
    expect(swap.verdicts[0]?.decision).toBe('REFUSE');
    const freysa = await sekisho.runBuilt(car, '', barriers.freysa, mandate, session('freysa'));
    expect(freysa.verdicts.every((v) => v.decision === 'REFUSE')).toBe(true);
  });
});

describe('boundary mode (connected cars)', () => {
  const driver = new GullibleDriver();

  it.each(['grok-morse', 'freysa', 'x402-swap'] as const)('%s: the gullible driver is refused via TAINT / MANDATE_PAYEE', async (id) => {
    const { sekisho, mandate } = await setup();
    const actions = await driver.act(barriers[id]);
    expect(actions[0].type).toBe('pay');
    const s = session(id);
    const out = await sekisho.runBoundary(car, barriers[id], actions, mandate, s);
    expect(out.intents).toHaveLength(1);
    expect(out.intents[0].mode).toBe('boundary');
    expect(out.intents[0].payTo).toMatchObject({ value: FAKE_ATTACKER, label: 'OPAQUE' });
    expect(out.intents[0].amountUsd.label).toBe('OPAQUE');
    const v = out.verdicts[0];
    expect(v.decision).toBe('REFUSE');
    expect(['TAINT', 'MANDATE_PAYEE']).toContain(v.blockedBy[0]);
    expect(v.blockedBy).toContain('MANDATE_PAYEE');
    expect(v.blockedBy).not.toContain('PROVENANCE_PAYEE'); // provenance is unknowable in boundary mode
    expect(s.tainted).toBe(true);
    expect(v.reason).toMatch(/only mandate payees may be paid/);
  });

  it('legit: the gullible driver pays the real weather address and is allowed through', async () => {
    const { sekisho, mandate } = await setup();
    const actions = await driver.act(barriers.legit);
    const out = await sekisho.runBoundary(car, barriers.legit, actions, mandate, session('legit'));
    expect(out.intents[0].payTo.value).toBe(FAKE_WEATHER);
    expect(out.verdicts[0].decision).toBe('PAY');
  });

  it('over-limit: $40 to weather steps up', async () => {
    const { sekisho, mandate } = await setup();
    const actions = await driver.act(barriers['over-limit']);
    const out = await sekisho.runBoundary(car, barriers['over-limit'], actions, mandate, session('over-limit'));
    expect(out.verdicts[0].decision).toBe('STEP_UP');
    expect(out.verdicts[0].blockedBy[0]).toBe('CAP_TX');
  });

  it('ENS names in actions are resolved by us; replies and noops are traced, not judged', async () => {
    const { sekisho, mandate } = await setup();
    const out = await sekisho.runBoundary(
      car,
      barriers.legit,
      [{ type: 'reply', text: 'ok' }, { type: 'noop' }, { type: 'pay', args: { payTo: 'weather.crumple.eth', amountUsd: 1, token: 'USDC', memo: 'x' } }],
      mandate,
      session('legit'),
    );
    expect(out.intents).toHaveLength(1);
    expect(out.intents[0].payTo.value).toBe(FAKE_WEATHER);
    expect(out.verdicts[0].decision).toBe('PAY');
  });
});
