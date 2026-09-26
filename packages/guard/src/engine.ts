import type { GuardReport } from './types.js';
import { scanSource } from './scan.js';

// STATIC-ONLY STUB. The compile + fork-deploy + dynamic proof-of-vulnerability path replaces `audit` (Task: engine).
// Kept as a working fallback so the feature always returns real static findings even without a fork.

export interface GuardEngine {
  /** Audit one single-file Solidity source. Static always; deploy + dynamic proof when a fork rpcUrl is configured. */
  audit(source: string, opts?: { name?: string }): Promise<GuardReport>;
}

/** Best-effort contract name from the source. */
export function contractNameOf(source: string): string {
  return source.match(/\bcontract\s+(\w+)/)?.[1] ?? 'Contract';
}

export function createGuardEngine(_cfg: { rpcUrl?: string } = {}): GuardEngine {
  return {
    async audit(source, opts) {
      const findings = scanSource(source);
      return {
        verdict: findings.length ? 'VULNERABLE' : 'SAFE',
        contractName: opts?.name ?? contractNameOf(source),
        findings,
        source,
        auditedAt: Date.now(),
      };
    },
  };
}
