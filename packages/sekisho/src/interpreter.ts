// Interpreter — plain code that executes a validated plan. This is where labels are attached.
// Invariants: an address is NEVER copied from text into a TOOL-labelled field; the only TOOL address
// is resolve(<ENS literal that came from the plan>). Everything the reader returns is UNTRUSTED.
import type { Address, ContentItem, Labeled, Mandate, Observation, PaymentIntent, SessionState, TraceLine } from '@crumple/core';
import type { Plan, PlanStep } from './planner.js';
import type { ReaderOutput, ReaderQuote } from './reader.js';
import { isAddress, sameAddress, short, trace, usd } from './util.js';

export interface InterpreterDeps {
  carId: string;
  resolve: (ens: string) => Promise<Address | null>;
  /** Runs the quarantined reader over every non-owner content item (memoised by the caller). */
  read: () => Promise<ReaderOutput>;
}

export interface InterpreterResult {
  intents: PaymentIntent[];
  trace: TraceLine[];
  /** true once any untrusted content was read — the session is tainted from here on */
  readerRan: boolean;
}

interface Quote {
  ens: string; // OWNER literal from the plan
  quote: ReaderQuote | null;
  item: ContentItem | null;
}

export async function interpret(plan: Plan, obs: Observation, mandate: Mandate, session: SessionState, deps: InterpreterDeps): Promise<InterpreterResult> {
  const out: InterpreterResult = { intents: [], trace: [], readerRan: false };
  const quotes = new Map<string, Quote>();
  const items = obs.content;
  let reader: ReaderOutput | null = null;
  const say = (text: string) => out.trace.push(trace('interpreter', text));
  const readOnce = async () => {
    if (!reader) {
      reader = await deps.read();
      out.readerRan = true;
    }
    return reader;
  };
  const nextId = () => `${obs.runId}-${obs.barrierId}-${out.intents.length}`;
  const base = { runId: obs.runId, carId: deps.carId, barrierId: obs.barrierId, mode: 'full' as const };

  for (const step of plan.steps) {
    switch (step.op) {
      case 'noop':
        say(`noop — ${step.reason || 'nothing to pay'}`);
        break;

      case 'fetch_quote': {
        const r = await readOnce();
        const q = r.quotes.find((c) => {
          const it = items[c.itemIndex];
          return it?.kind === 'http402' && (it.source.toLowerCase().includes(step.payee) || c.from.toLowerCase().includes(step.payee));
        });
        quotes.set(step.ref, { ens: step.payee, quote: q ?? null, item: q ? items[q.itemIndex] : null });
        if (q) say(`quote for ${step.payee}: 402 says pay ${short(q.payTo)} ${usd(q.amountUsd)} ${q.token} (UNTRUSTED)`);
        else say(`no 402 quote from ${step.payee} in the content`);
        break;
      }

      case 'read': {
        const r = await readOnce();
        const wanted = r.paymentRequests.filter((p) => !step.kind || items[p.itemIndex]?.kind === step.kind);
        say(`read(${step.kind ?? 'all'}) → ${wanted.length} payment request${wanted.length === 1 ? '' : 's'} in the content`);
        for (const p of wanted) {
          const intent = await candidateIntent(p, items[p.itemIndex], session, deps, nextId(), base);
          if (!intent) {
            say(`ignored a request from ${p.origin}: no usable payee`);
            continue;
          }
          out.intents.push(intent);
          say(`candidate: pay ${p.amountUsd == null ? 'everything' : usd(p.amountUsd)} ${p.token} to ${short(intent.payTo.value)} — from ${p.origin} (all fields UNTRUSTED)`);
        }
        break;
      }

      case 'pay': {
        const intent = await payIntent(step, quotes, mandate, deps, nextId(), base, say);
        if (intent) out.intents.push(intent);
        break;
      }
    }
  }
  if (!out.intents.length) say('nothing to pay');
  return out;
}

/** pay(): payTo is only ever resolve(ENS literal). A quote may override it to UNTRUSTED when the 402 disagrees. */
async function payIntent(
  step: Extract<PlanStep, { op: 'pay' }>,
  quotes: Map<string, Quote>,
  mandate: Mandate,
  deps: InterpreterDeps,
  id: string,
  base: Pick<PaymentIntent, 'runId' | 'carId' | 'barrierId' | 'mode'>,
  say: (t: string) => void,
): Promise<PaymentIntent | null> {
  // Which ENS name is this payment for? Either a literal or the quote's literal — both came from the plan.
  const payeeRef = step.payee.startsWith('$') ? step.payee.slice(1).split('.')[0] : null;
  const amountRef = typeof step.amount === 'string' ? step.amount.slice(1).split('.')[0] : null;
  const q = payeeRef ? quotes.get(payeeRef) : amountRef ? quotes.get(amountRef) : undefined;
  const ens = payeeRef ? q?.ens : step.payee;
  if (!ens) {
    say(`pay skipped — ${step.payee} does not point at a fetched quote`);
    return null;
  }
  const inMandate = mandate.payees.some((p) => p.ens.toLowerCase() === ens);
  const payeeEns: Labeled<string> = { value: ens, label: inMandate ? 'MANDATE' : 'OWNER', source: inMandate ? 'plan literal · mandate payee' : 'plan literal (owner request)' };

  const resolved = await deps.resolve(ens);
  if (!resolved) {
    say(`pay skipped — ${ens} does not resolve`);
    return null;
  }
  let payTo: Labeled<Address> = { value: resolved, label: 'TOOL', source: `resolve(${ens})` };

  // Amount
  let amountUsd: Labeled<number>;
  if (typeof step.amount === 'number') {
    amountUsd = { value: step.amount, label: 'OWNER', source: 'the owner request' };
  } else {
    if (!q || !q.quote) {
      say(`pay skipped — ${step.amount} refers to a quote that was not found`);
      return null;
    }
    const price = q.quote.amountUsd;
    const from = q.item?.source ?? '402 body';
    if (step.maxUsd != null && price <= step.maxUsd) {
      amountUsd = { value: price, label: 'OWNER_BOUNDED', source: `402 price ${usd(price)} ≤ owner ceiling ${usd(step.maxUsd)}` };
    } else if (step.maxUsd != null) {
      amountUsd = { value: price, label: 'UNTRUSTED', source: `a 402 (${from}) asking ${usd(price)}, above the owner's ${usd(step.maxUsd)} ceiling` };
    } else {
      amountUsd = { value: price, label: 'UNTRUSTED', source: `a 402 (${from}) with no owner ceiling` };
    }
  }

  // The quote's payTo must agree with resolution. If not, keep the 402 address as UNTRUSTED so policy refuses it visibly.
  if (q?.quote) {
    const said = q.quote.payTo;
    if (isAddress(said) && sameAddress(said, resolved)) {
      say(`402 payTo ${short(said)} matches resolve(${ens}) — payTo is TOOL`);
    } else {
      const shown = isAddress(said) ? said : resolved; // a garbage payTo still gets refused, shown as the resolved one
      payTo = { value: shown, label: 'UNTRUSTED', source: `the 402 body (${q.item?.source ?? '402'}) — it names ${isAddress(said) ? short(said) : 'an invalid address'}, not resolve(${ens}) = ${short(resolved)}` };
      say(`402 payTo ${isAddress(said) ? short(said) : '(invalid)'} ≠ resolve(${ens}) = ${short(resolved)} — keeping the 402 address as UNTRUSTED for policy`);
    }
  }

  const token = q?.quote?.token ?? 'USDC';
  say(`intent: pay ${usd(amountUsd.value)} ${token} to ${short(payTo.value)} [payee ${payTo.label}, amount ${amountUsd.label}]`);
  return {
    id,
    ...base,
    payTo,
    payeeEns,
    amountUsd,
    token,
    memo: { value: step.memo || `pay ${ens}`, label: 'OWNER', source: 'plan' },
  };
}

/** read(): every payment request the reader saw becomes a candidate intent with ALL fields UNTRUSTED. */
async function candidateIntent(
  p: ReaderOutput['paymentRequests'][number],
  item: ContentItem | undefined,
  session: SessionState,
  deps: InterpreterDeps,
  id: string,
  base: Pick<PaymentIntent, 'runId' | 'carId' | 'barrierId' | 'mode'>,
): Promise<PaymentIntent | null> {
  let addr: Address | null = null;
  if (isAddress(p.payTo)) addr = p.payTo;
  else if (p.payTo && /\.eth$/i.test(p.payTo)) addr = await deps.resolve(p.payTo.toLowerCase()).catch(() => null); // name from text → still UNTRUSTED
  if (!addr) return null;
  const origin = p.origin;
  const unspecified = p.amountUsd == null;
  return {
    id,
    ...base,
    payTo: { value: addr, label: 'UNTRUSTED', source: origin },
    payeeEns: p.payTo && !isAddress(p.payTo) ? { value: p.payTo, label: 'UNTRUSTED', source: origin } : undefined,
    amountUsd: {
      value: unspecified ? session.balanceUsd : p.amountUsd!,
      label: 'UNTRUSTED',
      source: unspecified ? `${origin}, which asked for everything` : origin,
    },
    token: p.token,
    memo: { value: p.instruction || item?.source || 'untrusted request', label: 'UNTRUSTED', source: origin },
  };
}
