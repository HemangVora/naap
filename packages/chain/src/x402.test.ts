// Offline: x402 encode/verify roundtrip with a local key, EIP-3009 signature recovery, slot math, domain hash.
import { describe, expect, it } from 'vitest';
import { hashDomain, keccak256, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  authorizationDigest,
  createXPayment,
  decodeXPayment,
  encodeXPayment,
  paymentPayloadFromAuth,
  paymentRequiredBody,
  paymentRequirements,
  recoverAuthorizationSigner,
  requirementsPriceUsd,
  signAuthorization,
  splitSignature,
  USDC_ADDRESS,
  USDC_DOMAIN,
  usdcBalanceSlot,
  usdToUnits,
  unitsToUsd,
  verifyPayment,
  authFields,
} from './index.js';

const buyer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'); // anvil #1
const weather = '0x1111111111111111111111111111111111111111' as const;
const attacker = '0xbad0000000000000000000000000000000000bad' as const;

describe('usdc constants', () => {
  it('USDC_DOMAIN hashes to the live Base DOMAIN_SEPARATOR', () => {
    // read from Base mainnet with `cast call USDC 'DOMAIN_SEPARATOR()(bytes32)'` on 2026-09-26
    const live = '0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f';
    expect(hashDomain({ domain: { ...USDC_DOMAIN, chainId: BigInt(USDC_DOMAIN.chainId) }, types: { EIP712Domain: [
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    ] } })).toBe(live);
  });
  it('balance slot = keccak256(abi.encode(holder, 9))', () => {
    const holder = '0x000000000000000000000000000000000000dEaD';
    expect(usdcBalanceSlot(holder)).toBe(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, 9n])));
    expect(usdcBalanceSlot(holder)).not.toBe(usdcBalanceSlot(weather));
  });
  it('usd ↔ units', () => {
    expect(usdToUnits(500)).toBe(500_000_000n);
    expect(usdToUnits(1.99)).toBe(1_990_000n);
    expect(usdToUnits(0.1 + 0.2)).toBe(300_000n);
    expect(unitsToUsd(1_000_000n)).toBe(1);
    expect(() => usdToUnits(-1)).toThrow();
  });
});

describe('eip3009', () => {
  it('signature recovers the signer and splits into v/r/s', async () => {
    const auth = await signAuthorization(buyer, { to: weather, value: 1_000_000n });
    expect(auth.from).toBe(buyer.address);
    expect(auth.token).toBe(USDC_ADDRESS);
    expect(await recoverAuthorizationSigner(authFields(auth), auth.signature)).toBe(buyer.address);
    const { v, r, s } = splitSignature(auth.signature);
    expect([27, 28]).toContain(v);
    expect(r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('digest changes with the domain (a fake 402 domain does not produce a valid USDC signature)', async () => {
    const auth = await signAuthorization(buyer, { to: weather, value: 1n, nonce: `0x${'11'.repeat(32)}`, validBefore: 1n });
    const f = authFields(auth);
    expect(authorizationDigest(f)).not.toBe(authorizationDigest(f, { ...USDC_DOMAIN, version: '1' }));
    const wrong = await recoverAuthorizationSigner(f, auth.signature, { ...USDC_DOMAIN, chainId: 1 });
    expect(wrong.toLowerCase()).not.toBe(buyer.address.toLowerCase());
  });
});

describe('x402', () => {
  const req = paymentRequirements({ payTo: weather, priceUsd: 1, resource: 'https://weather.crumple.eth/report', description: "Today's Tokyo weather report" });

  it('produces a realistic exact-scheme 402 body for Base', () => {
    const body = paymentRequiredBody(req);
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '1000000',
      payTo: weather,
      asset: USDC_ADDRESS,
      extra: { name: 'USD Coin', version: '2' },
      maxTimeoutSeconds: 60,
      mimeType: 'application/json',
    });
    expect(requirementsPriceUsd(req)).toBe(1);
    expect(() => paymentRequirements({ payTo: 'nope' as never, priceUsd: 1, resource: 'r' })).toThrow();
  });

  it('roundtrip: sign with a local key → header → verify', async () => {
    const header = await createXPayment(buyer, req);
    const decoded = decodeXPayment(header);
    expect(decoded.payload.authorization.to).toBe(weather);
    const res = await verifyPayment(header, req);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.payer).toBe(buyer.address);
      expect(res.amountUsd).toBe(1);
      expect(res.auth.token).toBe(USDC_ADDRESS);
      expect(res.auth.signature).toBe(decoded.payload.signature);
    }
  });

  it('rejects the x402-swap: payment signed for a swapped payTo does not verify against the real requirements', async () => {
    const swapped = paymentRequirements({ payTo: attacker, priceUsd: 1.99, resource: req.resource });
    const header = await createXPayment(buyer, swapped);
    const res = await verifyPayment(header, req);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toMatch(/payTo mismatch/);
  });

  it('rejects underpayment, expiry, not-yet-valid, wrong signer, and garbage', async () => {
    const cheap = await createXPayment(buyer, { ...req, maxAmountRequired: '500000' });
    expect((await verifyPayment(cheap, req)) as { reason?: string }).toMatchObject({ valid: false, reason: expect.stringMatching(/insufficient/) });

    const now = Math.floor(Date.now() / 1000);
    const stale = await createXPayment(buyer, req, { nowSec: now - 3600 });
    expect((await verifyPayment(stale, req)) as { reason?: string }).toMatchObject({ valid: false, reason: expect.stringMatching(/expired/) });

    const future = await signAuthorization(buyer, { to: weather, value: 1_000_000n, validAfter: BigInt(now + 1000) });
    expect((await verifyPayment(paymentPayloadFromAuth(future), req)) as { reason?: string }).toMatchObject({ valid: false, reason: expect.stringMatching(/not yet valid/) });

    const auth = await signAuthorization(buyer, { to: weather, value: 1_000_000n });
    const forged = paymentPayloadFromAuth({ ...auth, from: attacker });
    const res = await verifyPayment(forged, req);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toMatch(/recovers/);

    expect((await verifyPayment('not-base64-json', req)).valid).toBe(false);
    expect(() => decodeXPayment(encodeXPayment({ ...paymentPayloadFromAuth(auth), scheme: 'upto' as never }))).toThrow(/scheme/);
    expect(() => decodeXPayment(Buffer.from('{"x402Version":2}').toString('base64'))).toThrow(/x402Version/);
  });

  it('accepts overpayment (exact scheme: value ≥ maxAmountRequired)', async () => {
    const auth = await signAuthorization(buyer, { to: weather, value: 2_000_000n });
    const res = await verifyPayment(paymentPayloadFromAuth(auth), req);
    expect(res.valid).toBe(true);
  });
});
