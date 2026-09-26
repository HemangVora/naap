// ONE serial transaction queue for the single relayer wallet.
// Local nonce tracking; on nonce/replacement errors the nonce is refetched from the RPC and the send retried.
// Sepolia public RPCs lag on `pending` nonces — trusting them per-tx bit us; hence local tracking.
import type { Address, Hex } from '@crumple/core';

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  gas?: bigint;
  /** For logs only. */
  label?: string;
}

export interface TxReceiptLite {
  status: 'success' | 'reverted';
  blockNumber?: bigint;
}

/** The thin surface the queue needs from a chain client — mocked in tests, viem in production. */
export interface TxSender {
  /** Pending nonce for the relayer from the RPC. */
  getNonce(): Promise<number>;
  estimateGas(tx: TxRequest): Promise<bigint>;
  /** Sign + broadcast. Must throw on RPC rejection. Returns the tx hash. */
  send(tx: TxRequest & { nonce: number; gas: bigint }): Promise<Hex>;
  wait(hash: Hex): Promise<TxReceiptLite>;
}

export interface QueuedResult {
  hash: Hex;
  status: 'success' | 'reverted';
  nonce: number;
  attempts: number;
}

export interface NonceQueueOptions {
  /** Max send attempts per tx (default 4). */
  retries?: number;
  log?: (line: string) => void;
  /** Gas headroom multiplier over the estimate, in percent (default 25). */
  gasHeadroomPct?: number;
  /** Fallback gas limit when estimation fails but the caller provided none (default 300_000). */
  fallbackGas?: bigint;
}

const NONCE_ERROR = /nonce too low|nonce too high|nonce is too|invalid nonce|replacement transaction underpriced|replacement fee too low|already known|known transaction|NonceTooLow|NonceTooHigh|InvalidNonce|transaction underpriced/i;
const ALREADY_KNOWN = /already known|known transaction/i;

export function isNonceError(err: unknown): boolean {
  return NONCE_ERROR.test(errorText(err));
}
export function isAlreadyKnown(err: unknown): boolean {
  return ALREADY_KNOWN.test(errorText(err));
}
export function errorText(err: unknown): string {
  if (!err) return '';
  const e = err as { shortMessage?: string; details?: string; message?: string; cause?: unknown };
  return [e.shortMessage, e.details, e.message, e.cause ? errorText(e.cause) : ''].filter(Boolean).join(' | ');
}

export interface NonceQueue {
  /** Serialises the tx behind everything already queued. Resolves once mined (success or reverted). Rejects only on unrecoverable send errors. */
  submit(tx: TxRequest | (() => Promise<TxRequest>)): Promise<QueuedResult>;
  /** Number of txs waiting or in flight. */
  readonly size: number;
  /** Resolves when the queue is drained. */
  idle(): Promise<void>;
}

export function createNonceQueue(sender: TxSender, opts: NonceQueueOptions = {}): NonceQueue {
  const retries = opts.retries ?? 4;
  const log = opts.log ?? (() => {});
  const headroom = BigInt(100 + (opts.gasHeadroomPct ?? 25));
  const fallbackGas = opts.fallbackGas ?? 300_000n;

  let nextNonce: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let size = 0;

  async function refreshNonce(reason: string) {
    const n = await sender.getNonce();
    log(`nonce ← rpc ${n} (${reason})`);
    nextNonce = n;
    return n;
  }

  async function runOne(build: () => Promise<TxRequest>): Promise<QueuedResult> {
    const tx = await build();
    const label = tx.label ?? `${tx.to}:${tx.data.slice(0, 10)}`;
    let gas = tx.gas;
    if (!gas) {
      try {
        const est = await sender.estimateGas(tx);
        gas = (est * headroom) / 100n;
      } catch (e) {
        log(`estimateGas failed for ${label}: ${errorText(e).slice(0, 200)} — using fallback ${fallbackGas}`);
        gas = fallbackGas;
      }
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (nextNonce === null) await refreshNonce('first use');
      const nonce = nextNonce as number;
      try {
        const hash = await sender.send({ ...tx, nonce, gas });
        nextNonce = nonce + 1;
        log(`sent ${label} nonce=${nonce} ${hash}`);
        const rcpt = await sender.wait(hash);
        log(`mined ${label} nonce=${nonce} status=${rcpt.status}`);
        return { hash, status: rcpt.status, nonce, attempts: attempt };
      } catch (e) {
        lastErr = e;
        if (isNonceError(e) && attempt < retries) {
          log(`send ${label} nonce=${nonce} rejected (${errorText(e).slice(0, 120)}) — refetching nonce, retry ${attempt + 1}/${retries}`);
          await refreshNonce('nonce error');
          await sleep(250 * attempt);
          continue;
        }
        // Not a nonce problem (or out of retries). Local nonce is unknown now — resync on the next tx.
        nextNonce = null;
        throw e;
      }
    }
    nextNonce = null;
    throw lastErr;
  }

  return {
    submit(tx) {
      size++;
      const build = typeof tx === 'function' ? tx : async () => tx;
      const p = chain.then(() => runOne(build));
      chain = p.catch(() => {}).finally(() => {
        size--;
      });
      return p;
    },
    get size() {
      return size;
    },
    idle: () => chain.then(() => {}),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
