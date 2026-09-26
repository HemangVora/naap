import { describe, expect, it } from 'vitest';
import type { Hex } from '@crumple/core';
import { createNonceQueue, isNonceError, type TxRequest, type TxSender } from './nonceQueue.js';

const TO = '0x00000000000000000000000000000000000000aa' as const;
const tx = (label: string, data: Hex = '0x01'): TxRequest => ({ to: TO, data, label });

/** Mock RPC with a lagging pending nonce and scripted send failures. */
function mockSender(opts: { rpcNonce?: number; failures?: Record<number, string[]>; lag?: boolean; failAdvanceTo?: number } = {}) {
  const sent: { nonce: number; label?: string; hash: Hex }[] = [];
  const failures = opts.failures ?? {};
  let rpcNonce = opts.rpcNonce ?? 7;
  let nonceFetches = 0;
  const sender: TxSender = {
    async getNonce() {
      nonceFetches++;
      return rpcNonce;
    },
    async estimateGas() {
      return 100_000n;
    },
    async send(t) {
      const queued = failures[t.nonce];
      if (queued?.length) {
        if (opts.failAdvanceTo !== undefined) rpcNonce = opts.failAdvanceTo; // the RPC's real pending nonce was ahead of us
        throw new Error(queued.shift());
      }
      const hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}` as Hex;
      sent.push({ nonce: t.nonce, label: t.label, hash });
      if (!opts.lag) rpcNonce = Math.max(rpcNonce, t.nonce + 1); // a well-behaved RPC advances the pending nonce
      return hash;
    },
    async wait(hash) {
      return { status: hash.endsWith('bad') ? 'reverted' : 'success' };
    },
  };
  return { sender, sent, get nonceFetches() { return nonceFetches; }, setRpcNonce: (n: number) => (rpcNonce = n) };
}

describe('nonce queue', () => {
  it('sends serially with locally incremented nonces and fetches the nonce once', async () => {
    const m = mockSender({ rpcNonce: 7, lag: true }); // RPC never advances: local tracking must carry us
    const q = createNonceQueue(m.sender);
    const results = await Promise.all([q.submit(tx('a')), q.submit(tx('b')), q.submit(tx('c'))]);
    expect(m.sent.map((s) => s.nonce)).toEqual([7, 8, 9]);
    expect(m.sent.map((s) => s.label)).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.status)).toEqual(['success', 'success', 'success']);
    expect(m.nonceFetches).toBe(1);
    await q.idle();
    expect(q.size).toBe(0);
  });

  it('refetches the nonce and retries on "nonce too low"', async () => {
    const m = mockSender({ rpcNonce: 7, failures: { 7: ['nonce too low: next nonce 9, tx nonce 7'] }, failAdvanceTo: 9 });
    const q = createNonceQueue(m.sender, { log: () => {} });
    const r = await q.submit(tx('a'));
    expect(r.attempts).toBe(2);
    expect(r.nonce).toBe(9);
    expect(m.sent.map((s) => s.nonce)).toEqual([9]);
    // and the next tx continues locally from 10
    await q.submit(tx('b'));
    expect(m.sent.map((s) => s.nonce)).toEqual([9, 10]);
  });

  it('retries on "replacement transaction underpriced" and gives up after retries', async () => {
    const m = mockSender({ rpcNonce: 3, failures: { 3: ['replacement transaction underpriced', 'replacement transaction underpriced', 'replacement transaction underpriced', 'replacement transaction underpriced'] } });
    const q = createNonceQueue(m.sender, { retries: 3, log: () => {} });
    await expect(q.submit(tx('stuck'))).rejects.toThrow(/underpriced/);
    expect(m.sent).toHaveLength(0);
    // queue keeps working afterwards and resyncs the nonce
    m.setRpcNonce(4);
    const r = await q.submit(tx('next'));
    expect(r.nonce).toBe(4);
  });

  it('a non-nonce error rejects that tx only; later txs still go out (nonce resynced)', async () => {
    const m = mockSender({ rpcNonce: 0, failures: { 0: ['insufficient funds for gas * price + value'] } });
    const q = createNonceQueue(m.sender, { log: () => {} });
    const a = q.submit(tx('a'));
    const b = q.submit(tx('b'));
    await expect(a).rejects.toThrow(/insufficient funds/);
    const rb = await b;
    expect(rb.nonce).toBe(0);
    expect(m.nonceFetches).toBe(2);
  });

  it('reports reverted receipts without throwing and accepts lazy tx builders', async () => {
    const m = mockSender({ rpcNonce: 1 });
    m.sender.wait = async () => ({ status: 'reverted' });
    const q = createNonceQueue(m.sender);
    const r = await q.submit(async () => tx('lazy'));
    expect(r.status).toBe('reverted');
  });

  it('uses the caller gas or the estimate with headroom, falling back when estimation fails', async () => {
    const m = mockSender({ rpcNonce: 1 });
    const gasSeen: bigint[] = [];
    const inner = m.sender.send;
    m.sender.send = (t) => {
      gasSeen.push(t.gas);
      return inner(t);
    };
    const q = createNonceQueue(m.sender, { fallbackGas: 42n });
    await q.submit({ ...tx('explicit'), gas: 5n });
    await q.submit(tx('estimated'));
    m.sender.estimateGas = async () => {
      throw new Error('execution reverted');
    };
    await q.submit(tx('fallback'));
    expect(gasSeen).toEqual([5n, 125_000n, 42n]);
  });

  it('classifies nonce errors from viem-shaped errors', () => {
    expect(isNonceError({ shortMessage: 'Nonce provided for the transaction is lower than the current nonce', details: 'nonce too low' })).toBe(true);
    expect(isNonceError(new Error('already known'))).toBe(true);
    expect(isNonceError({ message: 'x', cause: { details: 'replacement fee too low' } })).toBe(true);
    expect(isNonceError(new Error('insufficient funds'))).toBe(false);
  });
});
