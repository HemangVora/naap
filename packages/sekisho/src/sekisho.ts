// createSekisho — the airbag. Full mode: tripwire → planner → reader → interpreter → policy.
// Boundary mode: a black box's actions → OPAQUE intents → policy.
import type { Address, AgentAction, Car, ContentItem, Mandate, MandateSource, Observation, PaymentIntent, Screener, Sekisho, SekishoOutcome, SessionState, TraceLine, Tripwire, TripwireResult, Verdict } from '@crumple/core';
import { interpret } from './interpreter.js';
import { HeuristicLlmClient, type LlmClient } from './llm.js';
import { describePlan, parsePlan, PlanError, type Plan } from './planner.js';
import { parseReaderOutput, ReaderError, type ReaderOutput } from './reader.js';
import { evaluatePolicy, type PolicyContext } from './policy.js';
import { isAddress, short, trace, usd } from './util.js';

export interface SekishoDeps {
  mandates: MandateSource;
  screener: Screener;
  tripwire: Tripwire;
  /** Missing → HeuristicLlmClient (offline). */
  llm?: LlmClient;
  tokenAddresses?: PolicyContext['tokenAddresses'];
  /** unix seconds, for tests */
  now?: () => number;
}

export function createSekisho(deps: SekishoDeps): Sekisho & { readonly llm: LlmClient } {
  const llm = deps.llm ?? new HeuristicLlmClient();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  async function tripwireFor(items: ContentItem[], out: TraceLine[]): Promise<TripwireResult> {
    const merged: TripwireResult = { escalate: false, flags: [] };
    for (const item of items) {
      try {
        const r = await deps.tripwire.assess(item);
        merged.escalate ||= r.escalate;
        merged.flags.push(...r.flags);
        const hot = r.flags.filter((f) => f.p >= 0.5).map((f) => `${label(f.question)} ${f.p.toFixed(2)}`);
        out.push(trace('tripwire', r.escalate ? `${item.source} → escalate (${hot.join(', ')})` : `${item.source} → clear`));
      } catch (e) {
        out.push(trace('tripwire', `${item.source} → tripwire unavailable (${msg(e)})`));
      }
    }
    return merged;
  }

  async function judge(intents: PaymentIntent[], mandate: Mandate, session: SessionState, tripwire: TripwireResult, out: TraceLine[]): Promise<Verdict[]> {
    const verdicts: Verdict[] = [];
    for (const intent of intents) {
      const v = await evaluatePolicy(intent, mandate, session, { screener: deps.screener, tripwire, now: now(), tokenAddresses: deps.tokenAddresses });
      for (const c of v.checks) out.push(trace(c.control === 'INTERCEPTA' ? 'screen' : 'policy', `${c.control} ${c.ok ? '✓' : '✗'} ${c.detail}`));
      out.push(trace('policy', `${v.decision} — ${v.reason}`));
      verdicts.push(v);
    }
    return verdicts;
  }

  return {
    llm,

    async runBuilt(car, persona, obs, mandate, session) {
      const out: TraceLine[] = [];
      const untrusted = obs.content.map((c, i) => ({ c, i })).filter(({ c }) => c.kind !== 'owner');
      const tripwire = await tripwireFor(untrusted.map((u) => u.c), out);

      // Planner: owner request + persona + mandate ENS names. Nothing else.
      let plan: Plan;
      try {
        const raw = await llm.plan({ ownerRequest: obs.ownerRequest, persona, mandatePayees: mandate.payees.map((p) => p.ens) });
        plan = parsePlan(raw);
        out.push(trace('planner', `${describePlan(plan)}${plan.note ? ` — "${plan.note}"` : ''}${llm.live ? '' : ' (offline planner)'}`));
      } catch (e) {
        out.push(trace('planner', `${e instanceof PlanError ? 'rejected plan' : 'failed'}: ${msg(e)} — nothing will be paid`));
        return { intents: [], verdicts: [], trace: out };
      }

      // Reader: quarantined, memoised, only over untrusted items.
      const read = async (): Promise<ReaderOutput> => {
        const indexes = untrusted.map((u) => u.i);
        try {
          const raw = await llm.read({ items: obs.content, indexes });
          const r = parseReaderOutput(raw, obs.content.length);
          out.push(trace('reader', `${r.quotes.length} quote${r.quotes.length === 1 ? '' : 's'}, ${r.paymentRequests.length} payment request${r.paymentRequests.length === 1 ? '' : 's'}${r.summary ? ` — ${r.summary}` : ''}${llm.live ? '' : ' (offline reader)'}`));
          return r;
        } catch (e) {
          out.push(trace('reader', `${e instanceof ReaderError ? 'rejected output' : 'failed'}: ${msg(e)} — treating content as unreadable`));
          return { summary: '', quotes: [], paymentRequests: [] };
        }
      };

      const result = await interpret(plan, obs, mandate, session, { carId: car.id, resolve: (ens) => deps.mandates.resolve(ens), read });
      out.push(...result.trace);

      if (result.readerRan) {
        session.tainted = true;
        for (const { c } of untrusted) if (!session.taintSources.includes(c.source)) session.taintSources.push(c.source);
      }

      const verdicts = await judge(result.intents, mandate, session, tripwire, out);
      return { intents: result.intents, verdicts, trace: out };
    },

    async runBoundary(car, obs, actions, mandate, session) {
      const out: TraceLine[] = [];
      const untrusted = obs.content.filter((c) => c.kind !== 'owner');
      const tripwire = await tripwireFor(untrusted, out);
      // The black box saw the content — the session is tainted whether or not it admits it.
      if (untrusted.length) {
        session.tainted = true;
        for (const c of untrusted) if (!session.taintSources.includes(c.source)) session.taintSources.push(c.source);
      }

      const intents: PaymentIntent[] = [];
      for (const a of actions) {
        if (a.type === 'reply') {
          out.push(trace('agent', `reply: ${a.text.replace(/\s+/g, ' ').slice(0, 80)}`));
          continue;
        }
        if (a.type === 'noop') {
          out.push(trace('agent', `noop${a.reason ? ` — ${a.reason.slice(0, 80)}` : ''}`));
          continue;
        }
        const args = a.args;
        const amount = Number(args.amountUsd);
        let payTo: Address | null = null;
        let payeeEns: PaymentIntent['payeeEns'];
        if (isAddress(args.payTo)) payTo = args.payTo;
        else if (/\.eth$/i.test(args.payTo)) {
          payTo = await deps.mandates.resolve(args.payTo.toLowerCase()).catch(() => null);
          payeeEns = { value: args.payTo.toLowerCase(), label: 'OPAQUE', source: 'agent action' };
        }
        if (!payTo || !Number.isFinite(amount) || amount < 0) {
          out.push(trace('agent', `pay ignored — unusable payTo/amount (${JSON.stringify(String(args.payTo).slice(0, 24))}, ${String(args.amountUsd)})`));
          continue;
        }
        const token = args.token === 'DRB' ? 'DRB' : 'USDC';
        out.push(trace('agent', `pay ${usd(amount)} ${token} to ${short(payTo)}${a.rationale ? ` — "${a.rationale.replace(/\s+/g, ' ').slice(0, 60)}"` : ''} (boundary mode: OPAQUE)`));
        intents.push({
          id: `${obs.runId}-${obs.barrierId}-${intents.length}`,
          runId: obs.runId,
          carId: car.id,
          barrierId: obs.barrierId,
          mode: 'boundary',
          payTo: { value: payTo, label: 'OPAQUE', source: 'agent action' },
          payeeEns,
          amountUsd: { value: amount, label: 'OPAQUE', source: 'agent action' },
          token,
          memo: { value: String(args.memo ?? '').slice(0, 80), label: 'OPAQUE', source: 'agent action' },
        });
      }
      if (!intents.length) out.push(trace('policy', 'no payment proposed — nothing to judge'));
      const verdicts = await judge(intents, mandate, session, tripwire, out);
      return { intents, verdicts, trace: out };
    },
  };
}

function label(q: string): string {
  const s = q.toLowerCase();
  if (s.includes('move funds') || s.includes('payment')) return 'moves funds';
  if (s.includes('encoded') || s.includes('obfuscated')) return 'encoded';
  if (s.includes('authority')) return 'claims authority';
  return q.slice(0, 24);
}

function msg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 120);
}

export type { SekishoOutcome, AgentAction, Car, Observation };
