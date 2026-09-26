import { describe, expect, it } from 'vitest';
import type { Verdict } from '@crumple/core';
import { FAKE_ATTACKER, FAKE_PAYEE, FakeMandateSource } from '@crumple/core';
import { verifyTypedData } from 'viem';
import { createSigner, typedDataFor, USDC_DOMAIN } from './signer.js';
import { legitIntent, mandateFor } from './test-fixtures.js';

const pay: Verdict = { decision: 'PAY', blockedBy: [], checks: [], reason: 'ok' };
const refuse: Verdict = { decision: 'REFUSE', blockedBy: ['PROVENANCE_PAYEE'], checks: [{ control: 'PROVENANCE_PAYEE', ok: false, detail: 'bad', ms: 0 }], reason: 'Payee came from untrusted text' };
const stepUp: Verdict = { decision: 'STEP_UP', blockedBy: ['CAP_TX'], checks: [{ control: 'CAP_TX', ok: false, detail: 'over cap', ms: 0 }], reason: 'over cap' };

const signer = createSigner({ seed: 'test-seed', now: () => 1_700_000_000 });
const mandateP = mandateFor(new FakeMandateSource());

describe('createSigner', () => {
  it('derives a distinct, deterministic wallet per (car, variant)', () => {
    const a = signer.walletFor('car1', 'bare');
    const b = signer.walletFor('car1', 'airbag');
    const c = signer.walletFor('car2', 'bare');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(createSigner({ seed: 'test-seed' }).walletFor('car1', 'bare')).toBe(a);
    expect(createSigner({ seed: 'other' }).walletFor('car1', 'bare')).not.toBe(a);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('signs a PAY verdict with an EIP-712 signature viem accepts for the Base USDC domain', async () => {
    const mandate = await mandateP;
    const auth = await signer.authorize(legitIntent(), pay, mandate);
    expect('signature' in auth).toBe(true);
    if (!('signature' in auth)) throw new Error('unreachable');
    expect(auth.from).toBe(signer.walletFor('car1', 'airbag'));
    expect(auth.to).toBe(FAKE_PAYEE);
    expect(auth.value).toBe('1000000');
    expect(auth.token).toBe(USDC_DOMAIN.verifyingContract);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(auth.validBefore)).toBe(1_700_000_600);
    const ok = await verifyTypedData({ address: auth.from, signature: auth.signature, ...typedDataFor(auth) });
    expect(ok).toBe(true);
    // a different domain must not verify
    const wrongDomain = await verifyTypedData({ address: auth.from, signature: auth.signature, ...typedDataFor(auth), domain: { ...USDC_DOMAIN, chainId: 1 } });
    expect(wrongDomain).toBe(false);
  });

  it('refuses a REFUSE verdict', async () => {
    const mandate = await mandateP;
    await expect(signer.authorize(legitIntent(), refuse, mandate)).rejects.toThrow(/signer refuses: verdict is REFUSE/);
  });

  it('refuses a tampered payTo even with a PAY verdict', async () => {
    const mandate = await mandateP;
    const tampered = legitIntent({ payTo: { value: FAKE_ATTACKER, label: 'TOOL', source: 'resolve(compute.naap.eth)' } });
    await expect(signer.authorize(tampered, pay, mandate)).rejects.toThrow(/not a mandate payee/);
    const untrusted = legitIntent({ payTo: { value: FAKE_PAYEE, label: 'UNTRUSTED', source: '402 body' } });
    await expect(signer.authorize(untrusted, pay, mandate)).rejects.toThrow(/UNTRUSTED/);
    const bigAmount = legitIntent({ amountUsd: { value: 40, label: 'OWNER', source: 'owner' } });
    await expect(signer.authorize(bigAmount, pay, mandate)).rejects.toThrow(/over the \$5 cap/);
  });

  it('STEP_UP signs only with an APPROVED step-up', async () => {
    const mandate = await mandateP;
    const big = legitIntent({ amountUsd: { value: 40, label: 'OWNER', source: 'owner' } });
    await expect(signer.authorize(big, stepUp, mandate)).rejects.toThrow(/step-up is missing/);
    await expect(signer.authorize(big, stepUp, mandate, { status: 'EXPIRED', detail: 'no owner' })).rejects.toThrow(/step-up is EXPIRED/);
    const auth = await signer.authorize(big, stepUp, mandate, { status: 'APPROVED', detail: 'world ok' });
    expect('value' in auth && auth.value).toBe('40000000');
  });

  it('bare mode signs anything, from the bare wallet', async () => {
    const mandate = await mandateP;
    const naive = legitIntent({ mode: 'bare', payTo: { value: FAKE_ATTACKER, label: 'UNTRUSTED', source: 'tweet' }, amountUsd: { value: 450, label: 'UNTRUSTED', source: 'tweet' } });
    const auth = await signer.authorize(naive, refuse, mandate);
    if (!('signature' in auth)) throw new Error('unreachable');
    expect(auth.from).toBe(signer.walletFor('car1', 'bare'));
    expect(auth.to).toBe(FAKE_ATTACKER);
    expect(auth.value).toBe('450000000');
    expect(await verifyTypedData({ address: auth.from, signature: auth.signature, ...typedDataFor(auth) })).toBe(true);
  });

  it('DRB is not signable yet', async () => {
    const mandate = await mandateP;
    await expect(signer.authorize(legitIntent({ mode: 'bare', token: 'DRB' }), pay, mandate)).rejects.toThrow(/DRB/);
  });
});
