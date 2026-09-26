// Policy — every check runs, in CONTRACT.md §Policy order, no short-circuit.
// evaluatePolicy() does the I/O (Intercepta) and hands everything to the pure evaluatePolicyPure().
import type { Address, CheckResult, Control, Decision, Mandate, PaymentIntent, ScreenResult, Screener, SessionState, TripwireResult, Verdict } from '@crumple/core';
import { sameAddress, short, usd } from './util.js';

export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Controls whose failure means REFUSE. Caps mean STEP_UP. JEV is friction only. */
const REFUSING: Control[] = ['PROVENANCE_AMOUNT', 'PROVENANCE_PAYEE', 'TAINT', 'MANDATE_PAYEE', 'MANDATE_EXPIRED', 'INTERCEPTA'];
const CAPS: Control[] = ['CAP_TX', 'CAP_DAILY'];

export interface PolicyContext {
  screener: Screener;
  /** Jev tripwire result for the content the session read (assessed before planning). */
  tripwire?: TripwireResult;
  /** unix seconds; defaults to now */
  now?: number;
  /** token addresses for Scan Token; DRB is unknown until lane chain finds it */
  tokenAddresses?: Partial<Record<'USDC' | 'DRB', Address>>;
}

export interface PurePolicyContext {
  /** Quick Scan of payTo (null = screener unavailable → treated as HOLD) */
  screen: ScreenResult | null;
  /** Scan Token of the token, when an address is known */
  tokenScreen?: ScreenResult | null;
  screenMs?: number;
  tripwire?: TripwireResult;
  now: number;
}

/** Runs Intercepta, then the pure policy. */
export async function evaluatePolicy(intent: PaymentIntent, mandate: Mandate, session: SessionState, ctx: PolicyContext): Promise<Verdict> {
  const t0 = Date.now();
  const tokenAddr = ctx.tokenAddresses?.[intent.token] ?? (intent.token === 'USDC' ? BASE_USDC : undefined);
  const [screen, tokenScreen] = await Promise.all([
    ctx.screener.quickScan(intent.payTo.value).catch(() => null),
    tokenAddr ? ctx.screener.scanToken(tokenAddr, 8453).catch(() => null) : Promise.resolve(undefined),
  ]);
  return evaluatePolicyPure(intent, mandate, session, {
    screen,
    tokenScreen,
    screenMs: Date.now() - t0,
    tripwire: ctx.tripwire,
    now: ctx.now ?? Math.floor(Date.now() / 1000),
  });
}

/** Pure: same inputs → same verdict. Every control appears exactly once in `checks`, in contract order. */
export function evaluatePolicyPure(intent: PaymentIntent, mandate: Mandate, session: SessionState, ctx: PurePolicyContext): Verdict {
  const checks: CheckResult[] = [];
  const full = intent.mode === 'full';
  const amount = intent.amountUsd.value;
  const payTo = intent.payTo.value;
  const payeeName = intent.payeeEns?.value;
  const mandatePayee = mandate.payees.find((p) => sameAddress(p.address, payTo));
  const namedPayee = payeeName ? mandate.payees.find((p) => p.ens.toLowerCase() === payeeName.toLowerCase()) : undefined;
  const who = mandatePayee ? `${mandatePayee.ens} (${short(payTo)})` : short(payTo);

  const add = (control: Control, ok: boolean, detail: string, ms = 0) => checks.push({ control, ok, detail, ms });

  // 1. PROVENANCE_AMOUNT (full mode)
  {
    const l = intent.amountUsd.label;
    const ok = !full || l === 'OWNER' || l === 'MANDATE' || l === 'OWNER_BOUNDED';
    add(
      'PROVENANCE_AMOUNT',
      ok,
      !full
        ? `boundary mode — amount provenance is OPAQUE, relying on TAINT + MANDATE_PAYEE + caps`
        : ok
          ? `amount ${usd(amount)} is ${l} — ${intent.amountUsd.source}`
          : `Amount ${usd(amount)} came from ${intent.amountUsd.source} (${l})`,
    );
  }

  // 2. PROVENANCE_PAYEE (full mode)
  {
    const l = intent.payTo.label;
    const nameOk = !!intent.payeeEns && (intent.payeeEns.label === 'OWNER' || intent.payeeEns.label === 'MANDATE');
    const ok = !full || (l === 'TOOL' && nameOk);
    let detail: string;
    if (!full) detail = `boundary mode — payee provenance is OPAQUE, relying on TAINT + MANDATE_PAYEE`;
    else if (ok) detail = `payTo ${short(payTo)} = resolve(${payeeName}) (TOOL)`;
    else if (l === 'UNTRUSTED' && namedPayee && !sameAddress(namedPayee.address, payTo))
      detail = `402 said pay ${short(payTo)}, but ${namedPayee.ens} resolves to ${short(namedPayee.address)}`;
    else if (l === 'TOOL') detail = `payTo ${short(payTo)} was resolved from a name that is not OWNER/MANDATE (${intent.payeeEns?.label ?? 'no name'})`;
    else detail = `Payee ${short(payTo)} came from ${intent.payTo.source} (${l})`;
    add('PROVENANCE_PAYEE', ok, detail);
  }

  // 3. TAINT
  {
    const tainted = session.tainted;
    const ok = !tainted || !!mandatePayee;
    const srcs = session.taintSources.slice(0, 2).join(', ') + (session.taintSources.length > 2 ? ', …' : '');
    add(
      'TAINT',
      ok,
      !tainted
        ? 'session read nothing untrusted'
        : ok
          ? `session read untrusted content (${srcs || 'content'}) → mandate-only; ${who} is a mandate payee`
          : `Session read untrusted content (${srcs || 'content'}), so only mandate payees may be paid — ${short(payTo)} is not one`,
    );
  }

  // 4. MANDATE_PAYEE, MANDATE_EXPIRED
  add('MANDATE_PAYEE', !!mandatePayee, mandatePayee ? `${who} is in the mandate` : `${short(payTo)} is not a mandate payee (mandate: ${mandate.payees.map((p) => p.ens).join(', ') || 'none'})`);
  {
    const ok = ctx.now < mandate.expiresAt;
    const when = new Date(mandate.expiresAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
    add('MANDATE_EXPIRED', ok, ok ? `mandate valid until ${when} UTC` : `Mandate for ${mandate.ensName} expired at ${when} UTC`);
  }

  // 5. CAP_TX, CAP_DAILY
  {
    const ok = amount <= mandate.perTxCapUsd;
    add('CAP_TX', ok, ok ? `${usd(amount)} ≤ ${usd(mandate.perTxCapUsd)} per-payment cap` : `${usd(amount)} to ${who} is over the ${usd(mandate.perTxCapUsd)} per-payment cap`);
    const dailyCap = (mandate.dailyCapBps / 10_000) * session.balanceUsd;
    const okDaily = session.spentTodayUsd + amount <= dailyCap + 1e-9;
    add(
      'CAP_DAILY',
      okDaily,
      okDaily
        ? `${usd(session.spentTodayUsd + amount)} today ≤ ${usd(dailyCap)} daily cap (${mandate.dailyCapBps / 100}% of ${usd(session.balanceUsd)})`
        : `${usd(session.spentTodayUsd)} already spent + ${usd(amount)} is over the ${usd(dailyCap)} daily cap (${mandate.dailyCapBps / 100}% of balance)`,
    );
  }

  // 6. INTERCEPTA
  {
    const s = ctx.screen;
    const t = ctx.tokenScreen ?? null;
    const off = s && !s.live ? ' · offline' : '';
    let ok: boolean;
    let detail: string;
    if (!s) {
      ok = false;
      detail = `Intercepta could not screen ${short(payTo)} — treated as HOLD`;
    } else if (s.verdict !== 'PASS') {
      ok = false;
      detail = `Intercepta ${s.verdict} for ${short(payTo)}: ${s.traits[0]?.description ?? `toxic score ${s.toxicScore}`}${off}`;
    } else if (t && t.verdict !== 'PASS') {
      ok = false;
      detail = `Intercepta ${t.verdict} for token ${intent.token}: ${t.traits[0]?.description ?? `toxic score ${t.toxicScore}`}${off}`;
    } else {
      ok = true;
      detail = `Intercepta PASS for ${short(payTo)} (score ${s.toxicScore})${t ? ` and ${intent.token}` : ''}${s.cached ? ' · cached' : ''}${off}`;
    }
    add('INTERCEPTA', ok, detail, ctx.screenMs ?? 0);
  }

  // 7. JEV_TRIPWIRE — friction only: fails only if something else already failed or amount > cap.
  {
    const tw = ctx.tripwire;
    const flagged = tw?.flags.filter((f) => f.p >= 0.5).map((f) => `${shortQuestion(f.question)} ${f.p.toFixed(2)}`) ?? [];
    const somethingFailed = checks.some((c) => !c.ok);
    const overCap = amount > mandate.perTxCapUsd;
    if (!tw) add('JEV_TRIPWIRE', true, 'Jev tripwire did not run');
    else if (!tw.escalate) add('JEV_TRIPWIRE', true, `Jev saw nothing alarming in the content${flagged.length ? ` (${flagged.join(', ')})` : ''}`);
    else if (somethingFailed || overCap) add('JEV_TRIPWIRE', false, `Jev flagged the content: ${flagged.join(', ')} — friction only, another check already failed`);
    else add('JEV_TRIPWIRE', true, `Jev flagged the content (${flagged.join(', ')}) but every other check passed — friction only, not a blocker`);
  }

  // Decision
  const failed = checks.filter((c) => !c.ok).map((c) => c.control);
  const refusing = failed.filter((c) => REFUSING.includes(c));
  const caps = failed.filter((c) => CAPS.includes(c));
  let decision: Decision;
  let primary: Control | undefined;
  if (refusing.length) {
    decision = 'REFUSE';
    primary = refusing[0];
  } else if (caps.length) {
    decision = 'STEP_UP';
    primary = caps[0];
  } else decision = 'PAY';
  const blockedBy: Control[] = primary ? [primary, ...failed.filter((c) => c !== primary)] : [];

  let reason: string;
  if (decision === 'PAY') reason = `Pay ${usd(amount)} to ${who} — every check passed`;
  else {
    const c = checks.find((x) => x.control === primary)!;
    reason = sentence(c.detail);
    if (decision === 'STEP_UP') reason += ' — asking the owner';
  }
  return { decision, blockedBy, checks, reason };
}

function sentence(detail: string): string {
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}

function shortQuestion(q: string): string {
  const s = q.toLowerCase();
  if (s.includes('move funds') || s.includes('payment')) return 'moves funds';
  if (s.includes('encoded') || s.includes('obfuscated')) return 'encoded';
  if (s.includes('authority')) return 'claims authority';
  return q.slice(0, 24);
}
