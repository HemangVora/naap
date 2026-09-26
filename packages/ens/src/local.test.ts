import { describe, expect, it } from 'vitest';
import { FAKE_WEATHER } from '@crumple/core';
import { agentAccountFor, canonicalMandateJson, createLocalMandateSource, createLocalRatingWriter } from './local.js';

const OWNER = '0x0000000000000000000000000000000000000001' as const;
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const; // throwaway test key

describe('local mandate source', () => {
  it('round-trips a signed mandate and resolves payees at read time', async () => {
    const src = createLocalMandateSource({ signerPk: PK });
    const created = await src.createForCar('Zx9', OWNER);
    expect(created.ensName).toBe('zx9.crumple.eth');
    expect(created.source).toBe('local');
    expect(created.payees).toEqual([{ ens: 'weather.crumple.eth', address: FAKE_WEATHER }]);
    const got = await src.get('ZX9.crumple.eth');
    expect(got.owner).toBe(OWNER);
    expect(got.perTxCapUsd).toBe(5);
    expect(got.dailyCapBps).toBe(1000);
    expect(got.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(await src.resolve('weather.crumple.eth')).toBe(FAKE_WEATHER);
    expect(await src.resolve('zx9.crumple.eth')).toBe(OWNER);
    expect(await src.resolve('nobody.crumple.eth')).toBeNull();
    expect(src.status('zx9.crumple.eth')).toBe('confirmed');
    await expect(src.get('nope.crumple.eth')).rejects.toThrow(/no mandate/);
  });

  it('envelope is EIP-191 signed by the configured signer and tampering is detected', async () => {
    const src = createLocalMandateSource({ signerPk: PK, weatherAddress: '0x2222222222222222222222222222222222222222' });
    await src.createForCar('t1', OWNER);
    const env = src.envelope('t1.crumple.eth')!;
    expect(env.signer).toBe(src.signer);
    expect(env.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(canonicalMandateJson(env.mandate)).toContain('"perTxCapUsd":5');
    env.mandate.perTxCapUsd = 500; // an attacker edits the stored JSON
    await expect(src.get('t1.crumple.eth')).rejects.toThrow(/signature/);
  });

  it('proveAgentCannotEdit rejects the agent forgery', async () => {
    const src = createLocalMandateSource({ signerPk: PK });
    await src.createForCar('t2', OWNER);
    const p = await src.proveAgentCannotEdit!('t2.crumple.eth');
    expect(p.rejected).toBe(true);
    expect(p.detail).toMatch(/offline/);
    expect(p.detail).toContain(agentAccountFor('t2').address.slice(0, 6));
  });

  it('agent key derivation is deterministic and differs per car', () => {
    expect(agentAccountFor('a').address).toBe(agentAccountFor('a').address);
    expect(agentAccountFor('a').address).not.toBe(agentAccountFor('b').address);
    expect(agentAccountFor('a', 'other-seed').address).not.toBe(agentAccountFor('a').address);
  });

  it('local rating writer stores and never confirms', async () => {
    const w = createLocalRatingWriter();
    let fired = false;
    w.onConfirmed(() => (fired = true));
    w.enqueue('c1', '', { stars: 3, bare: { stars: 1, lossUsd: 10, crashes: 1 }, airbag: { stars: 3, lossUsd: 0, crashes: 0 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(w.written[0].ensName).toBe('c1.crumple.eth');
    expect(fired).toBe(false);
  });
});
