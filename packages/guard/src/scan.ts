import type { GuardFinding, Severity } from './types.js';

// Deterministic static scan of a single-file Solidity source. It parses each function with its body and flags a
// curated set of classes an agent commonly gets wrong, naming the exact function. Heuristic, not a full analyzer:
// deliberately conservative about what counts as "guarded" so it does not under-report a missing access control.
// Defensive pre-deployment check — see docs/superpowers/specs/2026-09-27-deploy-guard-design.md.

export interface ParsedFunction {
  name: string;
  /** Raw parameter list text, e.g. "address to, uint256 amount". */
  params: string;
  /** The modifiers/visibility chunk between ")" and "{". */
  attrs: string;
  body: string;
  /** 1-based line of the `function` keyword. */
  line: number;
  visibility: 'external' | 'public' | 'internal' | 'private';
  isView: boolean;
  guarded: boolean;
}

const ACCESS_MODIFIER = /\b(only[A-Z]\w*|restricted|auth|authorized|requiresAuth)\b/;
const OWNER_REQUIRE =
  /\b(require|if)\s*\(\s*(?:_?msg\.sender|_?sender)\s*(?:==|!=)\s*(?:owner|admin|_owner|governance|_admin)\b|_checkOwner\s*\(|_checkRole\s*\(|ownerOnly/;

/** Condition text of every `require(...)` / `if (...)` in a body, with whether an `if` leads straight to a revert. */
function conditions(body: string): { kind: 'require' | 'if'; cond: string; reverts: boolean }[] {
  const out: { kind: 'require' | 'if'; cond: string; reverts: boolean }[] = [];
  const re = /\b(require|if)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    const cond = body.slice(re.lastIndex, i - 1);
    out.push({ kind: m[1] as 'require' | 'if', cond, reverts: /^\s*\{?\s*revert\b/.test(body.slice(i)) });
  }
  return out;
}

// Something msg.sender is compared against: `arbiter`, `pendingOwner`, `operator()`, `e.arbiter`, `escrows[id].buyer`.
const SUBJECT = String.raw`([A-Za-z_]\w*)((?:\[[^\]]*\])?(?:\.[A-Za-z_]\w*)*(?:\(\))?)`;
const END = String.raw`(?=\s*(?:&&|\|\||,|$))`;
const paramNames = (params: string) =>
  new Set(params.split(',').map((p) => p.trim().split(/\s+/).pop() ?? '').filter(Boolean));

/**
 * A caller check against a stored role: `require(msg.sender == X)` or `if (msg.sender != X) revert …` (either operand
 * order), where X is a state identifier, getter or member — never tx.origin/msg/block, and never one of the function's
 * own parameters (`require(msg.sender == to)` lets anyone pass themselves).
 */
function senderGuard(body: string, params: string): boolean {
  const own = paramNames(params);
  const isRole = (root: string, rest: string) => !/^(tx|msg|block|address|this)$/.test(root) && !(own.has(root) && !rest);
  for (const { kind, cond, reverts } of conditions(body)) {
    const op = kind === 'require' ? '==' : '!=';
    if (kind === 'if' && !reverts) continue;
    const c = cond.trim();
    const fwd = new RegExp(String.raw`msg\.sender\s*${op}\s*${SUBJECT}${END}`, 'g');
    const rev = new RegExp(String.raw`(?:^|[\s(&|!])${SUBJECT}\s*${op}\s*msg\.sender\b`, 'g');
    for (const re of [fwd, rev]) for (const x of c.matchAll(re)) if (isRole(x[1]!, x[2] ?? '')) return true;
  }
  return false;
}

/** Custom modifiers whose own body is a caller check, e.g. `modifier onlyArbiter` / `modifier gated`. */
function guardModifiers(src: string): Set<string> {
  const names = new Set<string>();
  const re = /\bmodifier\s+(\w+)\s*(?:\(([^)]*)\))?[^{;]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const body = src.slice(re.lastIndex, i - 1);
    if (OWNER_REQUIRE.test(body) || senderGuard(body, m[2] ?? '')) names.add(m[1]!);
  }
  return names;
}

const SENDER_SLOT = String.raw`[\w.]+\s*(?:\[[^\]]*\]\s*)*\[\s*msg\.sender\s*\](?:\.\w+)?`;
const SELF_SHAPED = /withdraw|claim|redeem|refund|unstake|exit|cashout/i;

/**
 * A withdraw/claim-shaped function that only touches the caller's own entry: it checks the caller's balance
 * (`require(balances[msg.sender] >= amount)`), deducts it (`balances[msg.sender] -= amount`, `= 0`, `delete`, `_burn`),
 * or is a one-time claim (`require(!claimed[msg.sender]); claimed[msg.sender] = true`). A stranger can only move
 * their own (zero) share, so it is not an "anyone can drain / mint" finding.
 */
function selfScoped(fn: ParsedFunction): boolean {
  if (!SELF_SHAPED.test(fn.name)) return false;
  const b = fn.body;
  const deducts =
    new RegExp(String.raw`${SENDER_SLOT}\s*(?:-=|=\s*0\s*;|=\s*${SENDER_SLOT}\s*-)`).test(b) ||
    new RegExp(String.raw`\bdelete\s+${SENDER_SLOT}`).test(b) ||
    /\b_burn\s*\(\s*msg\.sender\b/.test(b);
  if (deducts) return true;
  const conds = conditions(b).map((c) => c.cond);
  const balanceCheck = new RegExp(String.raw`${SENDER_SLOT}\s*(?:>=|>)|(?:<=|<)\s*${SENDER_SLOT}`);
  if (conds.some((c) => balanceCheck.test(c))) return true;
  const once = new RegExp(String.raw`!\s*(${SENDER_SLOT})`);
  return conds.some((c) => once.test(c)) && new RegExp(String.raw`${SENDER_SLOT}\s*=\s*true\b`).test(b);
}

/** Strip line and block comments so keywords in comments never trigger a finding. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

function lineOf(src: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

/** Extract every function with its body by brace-matching. Operates on comment-stripped source. */
export function parseFunctions(src: string): ParsedFunction[] {
  const out: ParsedFunction[] = [];
  const mods = guardModifiers(src);
  const sigRe = /\bfunction\s+(\w+)\s*\(([^)]*)\)([^{;]*)(\{|;)/g;
  let m: RegExpExecArray | null;
  while ((m = sigRe.exec(src))) {
    const [, name, params, attrs, open] = m;
    let body = '';
    if (open === '{') {
      let depth = 1;
      let i = sigRe.lastIndex;
      const start = i;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
      }
      body = src.slice(start, i - 1);
      sigRe.lastIndex = i;
    }
    const visibility = /\bexternal\b/.test(attrs)
      ? 'external'
      : /\binternal\b/.test(attrs)
        ? 'internal'
        : /\bprivate\b/.test(attrs)
          ? 'private'
          : 'public';
    const isView = /\b(view|pure)\b/.test(attrs);
    const guarded =
      ACCESS_MODIFIER.test(attrs) ||
      OWNER_REQUIRE.test(body) ||
      senderGuard(body, params) ||
      [...mods].some((mod) => new RegExp(String.raw`\b${mod}\b`).test(attrs));
    out.push({ name, params, attrs, body, line: lineOf(src, m.index), visibility, isView, guarded });
  }
  return out;
}

const MOVES_VALUE =
  /\.transfer\s*\(|\.send\s*\(|\.call\s*\{[^}]*value|selfdestruct\s*\(|suicide\s*\(|\.safeTransfer\s*\(/;
const MINTS = /\b_?mint\b|balanceOf\s*\[[^\]]+\]\s*(?:\+=|=)|totalSupply\s*(?:\+=|=)/;
const SETS_OWNER = /\b(owner|_owner|admin|_admin|governance)\s*=\s*[^=]/;
const SETS_PRICE = /\b(price|_price|rate|oracle|answer|latestAnswer|exchangeRate)\s*=\s*[^=]/;

function exposed(fn: ParsedFunction): boolean {
  return (fn.visibility === 'external' || fn.visibility === 'public') && !fn.isView && !fn.guarded;
}

/**
 * Static findings for a single-file contract. `confirmable` ids (unprotected-withdraw / unprotected-mint /
 * missing-access-control / unprotected-price) are the ones the dynamic prober tries to prove on the fork.
 */
export function scanSource(source: string): GuardFinding[] {
  const src = stripComments(source);
  const fns = parseFunctions(src);
  const findings: GuardFinding[] = [];
  const sig = (fn: ParsedFunction) => `${fn.name}(${fn.params.replace(/\s+/g, ' ').trim()})`;
  const push = (id: string, severity: Severity, title: string, detail: string, fn?: ParsedFunction) =>
    findings.push({ id, severity, title, detail, ...(fn ? { where: sig(fn), line: fn.line } : {}) });

  for (const fn of fns) {
    if (!exposed(fn)) continue;
    const isConstructor = fn.name === 'constructor';
    if (isConstructor) continue;
    const ownShare = selfScoped(fn);
    if (MOVES_VALUE.test(fn.body)) {
      if (!ownShare)
        push(
          'unprotected-withdraw',
          'critical',
          'Anyone can drain the contract',
          `${fn.name}() moves funds out but has no access control — any stranger can call it and take the balance.`,
          fn,
        );
    } else if (SETS_OWNER.test(fn.body)) {
      push(
        'missing-access-control',
        'critical',
        'Anyone can seize ownership',
        `${fn.name}() reassigns owner/admin with no access control — a stranger can make themselves the owner.`,
        fn,
      );
    } else if (SETS_PRICE.test(fn.body)) {
      push(
        'unprotected-price',
        'high',
        'Anyone can set the price feed',
        `${fn.name}() updates a price/oracle value with no access control — a stranger can mis-price collateral (the Moonwell class).`,
        fn,
      );
    } else if (!ownShare && MINTS.test(fn.body) && /\b(mint|issue|claim|reward|airdrop|faucet)\b/i.test(fn.name)) {
      push(
        'unprotected-mint',
        'critical',
        'Anyone can mint unlimited supply',
        `${fn.name}() increases balances/supply with no access control — a stranger can mint tokens to themselves.`,
        fn,
      );
    }
    if (/\btx\.origin\b/.test(fn.body)) {
      push('tx-origin-auth', 'high', 'Authentication via tx.origin', `${fn.name}() authenticates with tx.origin, which a malicious contract can phish.`, fn);
    }
    if (/\.delegatecall\s*\(/.test(fn.body) && /\baddress\b/.test(fn.params)) {
      push(
        'delegatecall-untrusted',
        'high',
        'delegatecall to a caller-supplied address',
        `${fn.name}() delegatecalls into an address the caller controls — it can run arbitrary code in this contract's context.`,
        fn,
      );
    }
  }
  // dedupe by (id, where)
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.id}|${f.where ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Ids the dynamic prober can confirm with a real attacker transaction on the fork. */
export const CONFIRMABLE = new Set(['unprotected-withdraw', 'unprotected-mint', 'missing-access-control', 'unprotected-price']);
