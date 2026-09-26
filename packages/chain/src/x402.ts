// x402 v1 `exact` scheme on Base (USDC / EIP-3009): seller-side 402 body, X-PAYMENT decode, and verification.
// Shape follows coinbase/x402 (PaymentRequirements / PaymentPayload) so a real x402 client could pay us.
import { isAddress, type Address, type Hex } from 'viem';
import type { Eip3009Auth } from '@crumple/core';
import { recoverAuthorizationSigner, signAuthorization, type Eip712Domain } from './eip3009.js';
import { USDC_ADDRESS, USDC_DOMAIN, unitsToUsd, usdToUnits } from './usdc.js';
import type { PrivateKeyAccount } from 'viem';

export const X402_VERSION = 1;
export const X402_NETWORK = 'base';

export interface PaymentRequirements {
  scheme: 'exact';
  network: 'base';
  /** base units, decimal string */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  /** EIP-712 domain hints for the asset (name/version) — what the client signs against. */
  extra: { name: string; version: string };
  outputSchema?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 1;
  error: string;
  accepts: PaymentRequirements[];
}

export interface ExactEvmPayload {
  signature: Hex;
  authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
}
export interface PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: 'base';
  payload: ExactEvmPayload;
}

export interface PaymentRequirementsInput {
  payTo: Address;
  priceUsd: number;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  asset?: Address;
  /** Override the domain hint (the attacker's fake 402 may lie here; the verifier uses the real USDC_DOMAIN). */
  extra?: { name: string; version: string };
}

/** Builds the `accepts[0]` entry of a 402 for a USDC price on Base. */
export function paymentRequirements(input: PaymentRequirementsInput): PaymentRequirements {
  if (!isAddress(input.payTo)) throw new Error(`paymentRequirements: bad payTo ${input.payTo}`);
  return {
    scheme: 'exact',
    network: X402_NETWORK,
    maxAmountRequired: usdToUnits(input.priceUsd).toString(),
    resource: input.resource,
    description: input.description ?? '',
    mimeType: input.mimeType ?? 'application/json',
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 60,
    asset: input.asset ?? USDC_ADDRESS,
    extra: input.extra ?? { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version },
  };
}

/** The full 402 response body (`accepts` list). Send with status 402 and `content-type: application/json`. */
export function paymentRequiredBody(input: PaymentRequirementsInput | PaymentRequirements, error = 'X-PAYMENT header is required'): PaymentRequired {
  const req = 'scheme' in input ? input : paymentRequirements(input);
  return { x402Version: X402_VERSION, error, accepts: [req] };
}

/** USD price of a requirements entry (for display). */
export function requirementsPriceUsd(req: PaymentRequirements): number {
  return unitsToUsd(BigInt(req.maxAmountRequired));
}

// ─── X-PAYMENT header ────────────────────────────────────────────────────────

export function encodeXPayment(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** Decodes an X-PAYMENT header (base64 JSON). Throws on malformed input; does not verify anything. */
export function decodeXPayment(header: string): PaymentPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header.trim(), 'base64').toString('utf8'));
  } catch (e) {
    throw new Error(`X-PAYMENT: not base64 JSON (${(e as Error).message})`);
  }
  const p = json as Partial<PaymentPayload>;
  if (!p || typeof p !== 'object') throw new Error('X-PAYMENT: not an object');
  if (p.x402Version !== X402_VERSION) throw new Error(`X-PAYMENT: unsupported x402Version ${String(p.x402Version)}`);
  if (p.scheme !== 'exact') throw new Error(`X-PAYMENT: unsupported scheme ${String(p.scheme)}`);
  if (p.network !== X402_NETWORK) throw new Error(`X-PAYMENT: unsupported network ${String(p.network)}`);
  const pl = p.payload as Partial<ExactEvmPayload> | undefined;
  const a = pl?.authorization;
  if (!pl || typeof pl.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(pl.signature)) throw new Error('X-PAYMENT: missing/invalid signature');
  if (!a || !isAddress(a.from) || !isAddress(a.to)) throw new Error('X-PAYMENT: authorization.from/to must be addresses');
  for (const k of ['value', 'validAfter', 'validBefore'] as const) {
    if (typeof a[k] !== 'string' || !/^\d+$/.test(a[k])) throw new Error(`X-PAYMENT: authorization.${k} must be a decimal string`);
  }
  if (typeof a.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) throw new Error('X-PAYMENT: authorization.nonce must be bytes32');
  return p as PaymentPayload;
}

/** Wraps a signed authorization as the X-PAYMENT payload a buyer would send. */
export function paymentPayloadFromAuth(auth: Eip3009Auth): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: X402_NETWORK,
    payload: {
      signature: auth.signature,
      authorization: { from: auth.from, to: auth.to, value: auth.value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce },
    },
  };
}

export function authFromPaymentPayload(p: PaymentPayload, asset: Address = USDC_ADDRESS): Eip3009Auth {
  const a = p.payload.authorization;
  return { from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce, signature: p.payload.signature, token: asset };
}

/** Buyer-side helper (tests/smoke/naive drivers): sign a payment for a 402 with a local key and return the header. */
export async function createXPayment(account: PrivateKeyAccount, req: PaymentRequirements, opts: { domain?: Eip712Domain; nowSec?: number } = {}): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const auth = await signAuthorization(account, {
    to: req.payTo,
    value: BigInt(req.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(now + req.maxTimeoutSeconds),
    token: req.asset,
    domain: opts.domain ?? { ...USDC_DOMAIN, verifyingContract: req.asset },
  });
  return encodeXPayment(paymentPayloadFromAuth(auth));
}

// ─── Verification (seller/facilitator side, no network) ──────────────────────

export type VerifyResult =
  | { valid: true; auth: Eip3009Auth; payer: Address; amountUsd: number }
  | { valid: false; reason: string; payer?: Address };

export interface VerifyOpts {
  nowSec?: number;
  /** validBefore must exceed now + this (x402 uses 6 s so settlement has time to land). Default 6. */
  minRemainingSec?: number;
  /** EIP-712 domain to recover against. Default USDC_DOMAIN with verifyingContract = requirements.asset. */
  domain?: Eip712Domain;
}

/**
 * Verifies an X-PAYMENT (header string or decoded payload) against what the seller asked for:
 * scheme/network, asset, payTo, amount (≥ maxAmountRequired, as in the x402 exact scheme), time window,
 * and that the EIP-712 signature recovers `authorization.from`. On-chain state (balance, nonce reuse) is
 * checked by `settle()` when the tx is simulated.
 */
export async function verifyPayment(xPayment: string | PaymentPayload, req: PaymentRequirements, opts: VerifyOpts = {}): Promise<VerifyResult> {
  let p: PaymentPayload;
  try {
    p = typeof xPayment === 'string' ? decodeXPayment(xPayment) : xPayment;
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }
  if (p.scheme !== req.scheme || p.network !== req.network) return { valid: false, reason: `scheme/network mismatch: got ${p.scheme}/${p.network}, want ${req.scheme}/${req.network}` };
  const a = p.payload.authorization;
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { valid: false, reason: `payTo mismatch: authorization.to=${a.to}, requirements.payTo=${req.payTo}`, payer: a.from };
  const value = BigInt(a.value);
  const want = BigInt(req.maxAmountRequired);
  if (value < want) return { valid: false, reason: `insufficient amount: ${unitsToUsd(value)} < ${unitsToUsd(want)} USD`, payer: a.from };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const validAfter = BigInt(a.validAfter);
  const validBefore = BigInt(a.validBefore);
  if (validAfter > BigInt(now)) return { valid: false, reason: `authorization not yet valid (validAfter=${validAfter}, now=${now})`, payer: a.from };
  if (validBefore < BigInt(now + (opts.minRemainingSec ?? 6))) return { valid: false, reason: `authorization expired or expiring (validBefore=${validBefore}, now=${now})`, payer: a.from };

  const domain = opts.domain ?? { ...USDC_DOMAIN, verifyingContract: req.asset };
  let recovered: Address;
  try {
    recovered = await recoverAuthorizationSigner({ from: a.from, to: a.to, value, validAfter, validBefore, nonce: a.nonce }, p.payload.signature, domain);
  } catch (e) {
    return { valid: false, reason: `signature unrecoverable: ${(e as Error).message}`, payer: a.from };
  }
  if (recovered.toLowerCase() !== a.from.toLowerCase()) return { valid: false, reason: `signature recovers ${recovered}, not authorization.from ${a.from}`, payer: a.from };

  return { valid: true, auth: authFromPaymentPayload(p, req.asset), payer: a.from, amountUsd: unitsToUsd(value) };
}
