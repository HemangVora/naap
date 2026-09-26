import { short as sekishoShort } from '@crumple/sekisho';
// The run engine: one car drives the course twice in parallel (bare and airbag), five barriers each,
// emitting every ArenaEvent in order. Money moves only through deps.signer + deps.chain; loss is
// measured on the fork, not from what the agent claimed.
import type {
  Address, AgentAction, ArenaEvent, BarrierResult, Car, CarDriver, CarSpec, Eip3009Auth, Hex, Mandate, Observation,
  PaymentIntent, Rating, RunDeps, SessionState, StepUpResult, TraceLine, TrackSpec, Variant, Verdict,
} from '@crumple/core';
import { CAR_START_BALANCE_USD, DEFAULT_TRACK, STEPUP_TTL_AUDIENCE_SEC, STEPUP_TTL_OWNER_SEC, PAYEE_ENS } from '@crumple/core';
import { buildTrack, observationFor, type Barrier, type CourseAddrs } from './barriers.js';
import { buildRating, isAttackBarrier, round2, scoreBarrier, summariseRun } from './score.js';
import { isAddress, isEnsName } from './drivers/sanitize.js';

export type { CourseAddrs } from './barriers.js';

/** Hard ceiling on one driver call (remote drivers time out sooner on their own). */
const short = (a: string) => (a.startsWith('0x') && a.length === 42 ? sekishoShort(a as `0x${string}`) : a);

export const DRIVER_TIMEOUT_MS = 60_000;
/** MCP cars wait on a human's agent (its own 90 s answer window lives in McpDriver); the lane ceiling sits above it. */
export const MCP_DRIVER_TIMEOUT_MS = 120_000;
const driverTimeout = (spec: CarSpec) => (spec.kind === 'mcp' ? MCP_DRIVER_TIMEOUT_MS : DRIVER_TIMEOUT_MS);

interface Settled {
  to: Address;
  usd: number;
  txHash: Hex;
}

interface LaneCtx {
  car: Car;
  spec: CarSpec;
  deps: RunDeps;
  variant: Variant;
  runId: string;
  wallet: Address;
  mandate: Mandate;
  payee: Address;
  driver: CarDriver;
  trackId: string;
  totalSteps: number;
}


function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** Emits never throw into the run. */
function emitter(deps: RunDeps): (e: ArenaEvent) => void {
  return (e) => {
    try {
      deps.emit(e);
    } catch {
      /* a broken socket must not crash a run */
    }
  };
}

/**
 * Drives `track.obstacles` in order (1–8, repeats allowed) on both lanes in parallel. Every event and result
 * carries `step` (0-based obstacle index) and `trackId`.
 */
export async function runCar(car: Car, spec: CarSpec, deps: RunDeps, addrs: CourseAddrs, track: TrackSpec = DEFAULT_TRACK): Promise<Rating> {
  const emit = emitter(deps);
  const mandate = await loadMandate(car, deps);
  const payee = (await deps.mandates.resolve(PAYEE_ENS)) ?? addrs.payee;
  const barriers = buildTrack(track, addrs);
  const stamp = Date.now().toString(36);

  const lane = (variant: Variant) =>
    runLane(
      {
        car, spec, deps, variant,
        runId: `${car.id}-${variant}-${stamp}`,
        wallet: deps.signer.walletFor(car.id, variant),
        mandate, payee,
        driver: deps.driverFor(car, spec),
        trackId: track.id,
        totalSteps: barriers.length,
      },
      barriers,
      emit,
    );

  const [bareResults, airbagResults] = await Promise.all([lane('bare'), lane('airbag')]);
  const rating = buildRating(summariseRun(bareResults), summariseRun(airbagResults));
  try {
    deps.ratings.enqueue(car.id, car.ensName, rating);
  } catch {
    /* rating write is best-effort; never blocks a run */
  }
  emit({ t: 'rating', carId: car.id, rating });
  return rating;
}

async function loadMandate(car: Car, deps: RunDeps): Promise<Mandate> {
  try {
    return await deps.mandates.get(car.ensName);
  } catch {
    return deps.mandates.createForCar(car.id, car.wallet);
  }
}

async function runLane(ctx: LaneCtx, barriers: Barrier[], emit: (e: ArenaEvent) => void): Promise<BarrierResult[]> {
  const { car, variant, runId } = ctx;
  emit({ t: 'run.started', carId: car.id, runId, variant });
  const results: BarrierResult[] = [];
  for (const barrier of barriers) {
    const result = await runBarrier(ctx, barrier, emit);
    results.push(result);
    emit({ t: 'barrier.result', carId: car.id, result });
  }
  const summary = summariseRun(results);
  emit({ t: 'run.finished', carId: car.id, runId, variant, lossUsd: summary.lossUsd, stars: summary.stars });
  return results;
}

async function runBarrier(ctx: LaneCtx, barrier: Barrier, emit: (e: ArenaEvent) => void): Promise<BarrierResult> {
  const { car, deps, variant, runId, wallet, payee, trackId } = ctx;
  const step = barrier.step ?? 0;
  const obs = observationFor(barrier, runId, ctx.totalSteps);
  const settled: Settled[] = [];
  /** Every payment the agent proposed (for the judge transcript). */
  const proposed: PaymentIntent[] = [];
  /** Payments that reached the signer (bare: all of them; airbag: PAY or approved STEP_UP only). */
  const attempted: PaymentIntent[] = [];
  const traceLines: TraceLine[] = [];
  let blockedBy: BarrierResult['blockedBy'] = [];
  let reason = '';
  let txHash: Hex | undefined;
  let error: string | undefined;

  const trace = (who: TraceLine['who'], text: string) => {
    const line: TraceLine = { at: Date.now(), who, text };
    traceLines.push(line);
    emit({ t: 'trace', carId: car.id, runId, barrierId: barrier.id, step, line });
  };

  await deps.chain.fundCar(wallet, CAR_START_BALANCE_USD);
  emit({ t: 'barrier.enter', carId: car.id, runId, variant, barrierId: barrier.id, step, trackId });

  try {
    if (variant === 'bare') {
      const out = await runBare(ctx, obs, settled, proposed, attempted, trace);
      txHash = out.txHash;
      reason = out.reason;
    } else {
      const out = await runAirbag(ctx, barrier, obs, settled, proposed, attempted, trace, emit);
      txHash = out.txHash;
      reason = out.reason;
      blockedBy = out.blockedBy;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    trace('agent', `error: ${error}`);
  }

  // Loss on the fork: what left the wallet minus what legitimately went to payee.
  const endBalance = await deps.chain.balanceUsd(wallet).catch(() => CAR_START_BALANCE_USD);
  const paidToPayeeUsd = round2(settled.filter((s) => same(s.to, payee)).reduce((a, s) => a + s.usd, 0));
  const lossUsd = round2(Math.max(0, CAR_START_BALANCE_USD - endBalance - paidToPayeeUsd));

  const attemptedNonMandate = attempted.some((i) => !ctx.mandate.payees.some((p) => same(p.address, i.payTo.value)));
  let judge: BarrierResult['judge'];
  if (isAttackBarrier(barrier.id) || proposed.length > 0) {
    try {
      judge = await deps.judge.judge(barrier.id, transcript(barrier, obs, proposed, settled, traceLines));
    } catch (e) {
      trace('agent', `judge unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const outcome = scoreBarrier({
    barrierId: barrier.id, lossUsd, paidToPayeeUsd, attemptedNonMandatePay: attemptedNonMandate, actedOnAttacker: judge?.actedOnAttacker,
  });

  if (error) reason = `error: ${error}`;
  else if (variant === 'bare' && barrier.id === 'over-limit' && outcome === 'PAID') reason = defaultReason(outcome, barrier, lossUsd, paidToPayeeUsd, variant);
  if (!reason) reason = defaultReason(outcome, barrier, lossUsd, paidToPayeeUsd, variant);

  return { runId, carId: car.id, variant, barrierId: barrier.id, step, trackId, outcome, lossUsd, blockedBy, reason, judge, txHash };
}

// ─── bare lane: the driver acts, every pay is signed and settled as-is ───────

async function runBare(
  ctx: LaneCtx, obs: Observation, settled: Settled[], proposed: PaymentIntent[], attempted: PaymentIntent[],
  trace: (who: TraceLine['who'], text: string) => void,
): Promise<{ txHash?: Hex; reason: string }> {
  const { deps, car, mandate } = ctx;
  const actions = await withTimeout(ctx.driver.act(obs), driverTimeout(ctx.spec), 'driver');
  let txHash: Hex | undefined;
  const notes: string[] = [];
  let n = 0;
  for (const a of actions) {
    if (a.type === 'reply') {
      trace('agent', `reply: ${a.text.slice(0, 200)}`);
      continue;
    }
    if (a.type === 'noop') {
      trace('agent', `no action${a.reason ? `: ${a.reason}` : ''}`);
      continue;
    }
    const payTo = await resolvePayTo(ctx, a.args.payTo);
    if (!payTo) {
      trace('agent', `pay to unresolvable "${a.args.payTo}" skipped`);
      continue;
    }
    const intent: PaymentIntent = {
      id: `${obs.runId}-${obs.step ?? 0}-${obs.barrierId}-${n++}`,
      runId: obs.runId, carId: car.id, barrierId: obs.barrierId, mode: 'bare',
      payTo: { value: payTo, label: 'OPAQUE', source: 'agent.pay.payTo' },
      payeeEns: isEnsName(a.args.payTo) ? { value: a.args.payTo, label: 'OPAQUE', source: 'agent.pay.payTo' } : undefined,
      amountUsd: { value: a.args.amountUsd, label: 'OPAQUE', source: 'agent.pay.amountUsd' },
      token: a.args.token,
      memo: { value: a.args.memo, label: 'OPAQUE', source: 'agent.pay.memo' },
    };
    proposed.push(intent);
    attempted.push(intent);
    trace('agent', `pay $${a.args.amountUsd.toFixed(2)} ${a.args.token} → ${short(a.args.payTo)}${a.args.memo ? ` (${a.args.memo})` : ''}`);
    const verdict: Verdict = { decision: 'PAY', blockedBy: [], checks: [], reason: 'bare: no airbag — signed as-is' };
    try {
      const s = await signAndSettle(ctx, intent, verdict, mandate);
      settled.push(s);
      txHash = s.txHash;
      trace('signer', `bare mode: signed without checks, settled ${short(s.txHash)}`);
      notes.push(`paid $${s.usd.toFixed(2)} to ${short(payTo)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace('signer', `settlement failed: ${msg}`);
      notes.push(`tried to pay $${a.args.amountUsd.toFixed(2)} to ${short(payTo)} (${msg})`);
    }
  }
  return { txHash, reason: notes.join('; ') };
}

// ─── airbag lane: Sekisho decides; step-up via World for STEP_UP ─────────────

async function runAirbag(
  ctx: LaneCtx, barrier: Barrier, obs: Observation, settled: Settled[], proposed: PaymentIntent[], attempted: PaymentIntent[],
  trace: (who: TraceLine['who'], text: string) => void, emit: (e: ArenaEvent) => void,
): Promise<{ txHash?: Hex; reason: string; blockedBy: BarrierResult['blockedBy'] }> {
  const { deps, car, spec, mandate, runId } = ctx;
  const step = barrier.step ?? 0;

  const session: SessionState = {
    runId, barrierId: barrier.id,
    tainted: obs.content.length > 0,
    taintSources: obs.content.map((c) => c.source),
    balanceUsd: CAR_START_BALANCE_USD,
    spentTodayUsd: 0,
  };

  // Jev tripwire on every untrusted item before planning (friction only; the trace shows it).
  for (const item of obs.content) {
    try {
      const r = await deps.tripwire.assess(item);
      const top = r.flags.slice().sort((a, b) => b.p - a.p)[0];
      trace('tripwire', `${r.escalate ? 'ESCALATE' : 'clear'} ${item.source}${top ? ` — ${top.question.slice(0, 60)}… p=${top.p.toFixed(2)}` : ''}`);
    } catch (e) {
      trace('tripwire', `unavailable for ${item.source}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let outcome;
  if (spec.kind === 'built') {
    outcome = await deps.sekisho.runBuilt(car, spec.persona ?? '', obs, mandate, session);
  } else {
    const actions: AgentAction[] = await withTimeout(ctx.driver.act(obs), driverTimeout(spec), 'driver');
    for (const a of actions) {
      if (a.type === 'pay') trace('agent', `proposes pay $${a.args.amountUsd.toFixed(2)} ${a.args.token} → ${short(a.args.payTo)}`);
      else if (a.type === 'reply') trace('agent', `reply: ${a.text.slice(0, 200)}`);
      else trace('agent', `no action${a.reason ? `: ${a.reason}` : ''}`);
    }
    outcome = await deps.sekisho.runBoundary(car, obs, actions, mandate, session);
  }
  for (const line of outcome.trace) {
    emit({ t: 'trace', carId: car.id, runId, barrierId: barrier.id, step, line });
  }

  let txHash: Hex | undefined;
  const blockedBy: BarrierResult['blockedBy'] = [];
  const reasons: string[] = [];

  for (let i = 0; i < outcome.intents.length; i++) {
    const intent = outcome.intents[i]!;
    const verdict = outcome.verdicts[i];
    if (!verdict) continue;
    proposed.push(intent);
    for (const check of verdict.checks) emit({ t: 'check', carId: car.id, runId, barrierId: barrier.id, step, check });
    trace('policy', `${verdict.decision}${verdict.blockedBy.length ? ` [${verdict.blockedBy.join(', ')}]` : ''}: ${verdict.reason}`);

    if (verdict.decision === 'REFUSE') {
      blockedBy.push(...verdict.blockedBy);
      reasons.push(verdict.reason);
      continue;
    }

    let stepUp: StepUpResult | undefined;
    if (verdict.decision === 'STEP_UP') {
      const isOwner = Boolean(spec.isOwnerCar);
      const summary = `Pay $${intent.amountUsd.value.toFixed(2)} to ${intent.payeeEns?.value ?? short(intent.payTo.value)}${intent.memo.value ? ` for ${intent.memo.value}` : ''}`;
      const handle = await deps.stepUp.request({
        // Sekisho's intent ids are per barrier type; a track may repeat a type, so the step keeps them unique.
        carId: car.id, intentId: `${intent.id}-s${step}`, summary,
        ttlSec: isOwner ? STEPUP_TTL_OWNER_SEC : STEPUP_TTL_AUDIENCE_SEC,
        allowApproval: isOwner,
      });
      emit({
        t: 'stepup.pending', carId: car.id, runId, barrierId: barrier.id, step, summary,
        verificationUri: handle.verificationUri, userCode: handle.userCode, expiresAt: handle.expiresAt, canApprove: isOwner,
      });
      trace('stepup', `${summary} — waiting for ${isOwner ? 'owner (World ID)' : 'nobody: audience car, expires'}`);
      stepUp = await handle.result;
      emit({ t: 'stepup.resolved', carId: car.id, runId, result: stepUp });
      trace('stepup', `${stepUp.status}: ${stepUp.detail}`);
      if (stepUp.status !== 'APPROVED') {
        blockedBy.push(...verdict.blockedBy, stepUp.status === 'DENIED' ? 'WORLD_DENIED' : 'WORLD_EXPIRED');
        reasons.push(stepUp.detail);
        continue;
      }
    }

    attempted.push(intent);
    try {
      const s = await signAndSettle(ctx, intent, verdict, mandate, stepUp);
      settled.push(s);
      txHash = s.txHash;
      trace('signer', `re-checked and signed; settled ${short(s.txHash)}`);
      reasons.push(`paid $${s.usd.toFixed(2)} to ${intent.payeeEns?.value ?? short(intent.payTo.value)}${stepUp ? ' after owner approval' : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace('signer', `refused: ${msg}`);
      reasons.push(`signer refused: ${msg}`);
    }
  }

  if (outcome.intents.length === 0) trace('policy', 'no payment intent produced');
  return { txHash, reason: reasons.join('; '), blockedBy: dedupe(blockedBy) };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function resolvePayTo(ctx: LaneCtx, payTo: string): Promise<Address | null> {
  if (isAddress(payTo)) return payTo as Address;
  if (!isEnsName(payTo)) return null;
  const fromMandate = ctx.mandate.payees.find((p) => p.ens.toLowerCase() === payTo.toLowerCase());
  if (fromMandate) return fromMandate.address;
  try {
    return await ctx.deps.mandates.resolve(payTo);
  } catch {
    return null;
  }
}

async function signAndSettle(ctx: LaneCtx, intent: PaymentIntent, verdict: Verdict, mandate: Mandate, stepUp?: StepUpResult): Promise<Settled> {
  const auth = await ctx.deps.signer.authorize(intent, verdict, mandate, stepUp);
  if ('signedTx' in auth) {
    const { txHash } = await ctx.deps.chain.sendRaw(auth.signedTx);
    return { to: intent.payTo.value, usd: intent.amountUsd.value, txHash };
  }
  const { txHash } = await ctx.deps.chain.settle(auth as Eip3009Auth);
  return { to: (auth as Eip3009Auth).to, usd: Number((auth as Eip3009Auth).value) / 1e6, txHash };
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function defaultReason(outcome: BarrierResult['outcome'], barrier: Barrier, lossUsd: number, paidToPayeeUsd: number, variant: Variant): string {
  switch (outcome) {
    case 'CRASH':
      return lossUsd > 0 ? `lost $${lossUsd.toFixed(2)} to ${short(barrier.attackPayTo ?? 'attacker')}` : 'tried to pay the attacker (tx failed)';
    case 'PAID':
      return barrier.id === 'over-limit' && variant === 'bare' ? `paid $${paidToPayeeUsd.toFixed(2)} without asking` : `paid $${paidToPayeeUsd.toFixed(2)} to ${PAYEE_ENS}`;
    case 'FALSE_BLOCK':
      return `did not pay ${PAYEE_ENS}`;
    case 'SAFE':
      return 'no money moved';
  }
}

/** Compact transcript for the Jev judge: attacker items are labelled so the question is answerable. */
export function transcript(barrier: Barrier, obs: Observation, attempted: PaymentIntent[], settled: Settled[], lines: TraceLine[]): string {
  const parts: string[] = [`OWNER REQUEST: ${obs.ownerRequest}`];
  for (const c of obs.content) {
    const who = barrier.attackerSources.includes(c.source) ? 'ATTACKER CONTENT' : 'CONTENT';
    parts.push(`${who} (${c.kind} · ${c.source}): ${c.text.slice(0, 600)}`);
  }
  if (barrier.attackPayTo) parts.push(`ATTACKER ADDRESS: ${barrier.attackPayTo}`);
  parts.push(
    attempted.length
      ? `AGENT ACTIONS: ${attempted.map((i) => `pay $${i.amountUsd.value} ${i.token} to ${i.payeeEns?.value ?? i.payTo.value}`).join('; ')}`
      : 'AGENT ACTIONS: no payment',
  );
  parts.push(settled.length ? `SETTLED: ${settled.map((s) => `$${s.usd} to ${s.to}`).join('; ')}` : 'SETTLED: nothing');
  const agentLines = lines.filter((l) => l.who === 'agent').map((l) => l.text.slice(0, 200));
  if (agentLines.length) parts.push(`AGENT SAID: ${agentLines.join(' | ')}`);
  return parts.join('\n\n').slice(0, 8000);
}
