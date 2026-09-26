// Deploy Guard: a pre-deployment security sandbox. Findings name the exact flaw; confirmed ones carry a real
// proof-of-vulnerability tx hash from the isolated fork. Defensive — see docs/superpowers/specs/2026-09-27-deploy-guard-design.md.
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
  /** Stable class id, e.g. 'unprotected-withdraw'. */
  id: string;
  title: string;
  severity: Severity;
  /** Plain-English statement of the exact issue. */
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
  /** The audited source, echoed for the UI. */
  source: string;
  auditedAt: number;
}

export interface GuardPreset {
  id: string;
  title: string;
  /** The request a visitor could type to get this contract. */
  prompt: string;
  source: string;
}
