// Deploy Guard (docs/superpowers/specs/2026-09-27-deploy-guard-design.md): the report types, mirrored from
// packages/guard/src/types.ts so no server package reaches the browser, and the thin client for /api/guard.
// Mock mode (`?mock=1`) swaps these for guard-mock.ts and never calls the fetches.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type GuardVerdict = 'VULNERABLE' | 'SAFE' | 'COMPILE_ERROR';

export interface GuardConfirmation {
  /** What a stranger managed to do to the sandbox contract, in plain words. */
  exploit: string;
  /** Real tx hash on the fork proving it. */
  txHash: string;
  /** USDC value a stranger moved out, when the flaw is a drain. */
  stolenUsd?: number;
  ownerBefore?: string;
  ownerAfter?: string;
}

export interface GuardFinding {
  id: string;
  title: string;
  severity: Severity;
  detail: string;
  /** The function or construct at fault, e.g. 'withdraw(address)'. */
  where?: string;
  line?: number;
  /** Present only when a proof-of-vulnerability tx succeeded on the fork. */
  confirmed?: GuardConfirmation;
}

export interface GuardReport {
  verdict: GuardVerdict;
  contractName: string;
  /** Deployed sandbox address on the Base fork (absent when not deployed). */
  address?: string;
  chainId?: number;
  findings: GuardFinding[];
  compileError?: string;
  source: string;
  auditedAt: number;
}

export interface GuardPreset {
  id: string;
  title: string;
  prompt: string;
  source: string;
}

/** Client-side mirrors of the server limits (the server enforces them too). */
export const GUARD_LIMITS = { promptMax: 600, sourceMaxBytes: 12 * 1024 } as const;

export interface GuardApi {
  presets(): Promise<{ presets: GuardPreset[] }>;
  draft(prompt: string): Promise<{ source: string; name: string }>;
  audit(source: string): Promise<{ report: GuardReport }>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

export const getPresets = () => call<{ presets: GuardPreset[] }>('/api/guard/presets');
export const draftContract = (prompt: string) =>
  call<{ source: string; name: string }>('/api/guard/draft', { method: 'POST', body: JSON.stringify({ prompt }) });
export const auditContract = (source: string) =>
  call<{ report: GuardReport }>('/api/guard/audit', { method: 'POST', body: JSON.stringify({ source }) });

export const liveGuardApi: GuardApi = { presets: getPresets, draft: draftContract, audit: auditContract };
