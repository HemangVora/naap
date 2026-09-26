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
    const guarded = ACCESS_MODIFIER.test(attrs) || OWNER_REQUIRE.test(body);
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
    if (MOVES_VALUE.test(fn.body)) {
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
    } else if (MINTS.test(fn.body) && /\b(mint|issue|claim|reward|airdrop|faucet)\b/i.test(fn.name)) {
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
