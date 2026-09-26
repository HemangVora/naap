// Every driver output passes through here. Remote agents are black boxes; never trust their shapes.
import type { AgentAction, PayArgs } from '@crumple/core';

export const MAX_ACTIONS = 8;
export const MAX_MEMO = 200;
export const MAX_REPLY = 2000;
export const MAX_AMOUNT_USD = 1_000_000;

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const ENS_RE = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

export function isAddress(s: string): boolean {
  return ADDRESS_RE.test(s);
}
export function isEnsName(s: string): boolean {
  return ENS_RE.test(s);
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // strip control chars, keep it printable
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

export function sanitisePayArgs(raw: unknown): PayArgs | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const payTo = str(o.payTo ?? o.to ?? o.payee, 253)?.trim() ?? '';
  if (!isAddress(payTo) && !isEnsName(payTo)) return null;
  const amountRaw = typeof o.amountUsd === 'string' ? Number(o.amountUsd) : o.amountUsd ?? o.amount;
  const amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_USD) return null;
  const token = o.token === 'DRB' ? 'DRB' : 'USDC';
  const memo = str(o.memo ?? '', MAX_MEMO) ?? '';
  return { payTo: isAddress(payTo) ? payTo : payTo.toLowerCase(), amountUsd: Math.round(amount * 100) / 100, token, memo };
}

export function sanitiseAction(raw: unknown): AgentAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case 'pay': {
      const args = sanitisePayArgs(o.args ?? o);
      if (!args) return null;
      const rationale = str(o.rationale, MAX_REPLY) ?? undefined;
      return rationale ? { type: 'pay', args, rationale } : { type: 'pay', args };
    }
    case 'reply': {
      const text = str(o.text, MAX_REPLY);
      return text === null ? null : { type: 'reply', text };
    }
    case 'noop': {
      const reason = str(o.reason, MAX_REPLY) ?? undefined;
      return reason ? { type: 'noop', reason } : { type: 'noop' };
    }
    default:
      return null;
  }
}

/** Accepts `{ actions: [...] }` or a bare array. Drops anything malformed. Caps the count. */
export function sanitiseActions(raw: unknown): AgentAction[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { actions?: unknown }).actions : undefined;
  if (!Array.isArray(list)) return [];
  const out: AgentAction[] = [];
  for (const item of list.slice(0, MAX_ACTIONS)) {
    const a = sanitiseAction(item);
    if (a) out.push(a);
  }
  return out;
}
