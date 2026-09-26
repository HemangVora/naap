// EIP-3009 `transferWithAuthorization` typed data: build, sign (tests/smoke/signer reference), recover.
import { hashTypedData, recoverTypedDataAddress, type Address, type Hex, type PrivateKeyAccount } from 'viem';
import type { Eip3009Auth } from '@crumple/core';
import { EIP3009_TYPES, USDC_ADDRESS, USDC_DOMAIN } from './usdc.js';

export interface AuthorizationFields {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export type Eip712Domain = { name: string; version: string; chainId: number; verifyingContract: Address };

export function authorizationTypedData(fields: AuthorizationFields, domain: Eip712Domain = USDC_DOMAIN) {
  return {
    domain,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: fields,
  };
}

export function authorizationDigest(fields: AuthorizationFields, domain: Eip712Domain = USDC_DOMAIN): Hex {
  return hashTypedData(authorizationTypedData(fields, domain));
}

/** Recovers the signer of a transferWithAuthorization signature. Pure (no network). */
export async function recoverAuthorizationSigner(fields: AuthorizationFields, signature: Hex, domain: Eip712Domain = USDC_DOMAIN): Promise<Address> {
  return recoverTypedDataAddress({ ...authorizationTypedData(fields, domain), signature });
}

export function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export interface SignAuthorizationOpts {
  to: Address;
  value: bigint;
  /** unix seconds; default 0 */
  validAfter?: bigint;
  /** unix seconds; default now + 300 s */
  validBefore?: bigint;
  nonce?: Hex;
  token?: Address;
  domain?: Eip712Domain;
}

/**
 * Signs a USDC transferWithAuthorization with a viem local account (reference implementation for the sekisho
 * signer; used by the smoke script and tests). Returns the core `Eip3009Auth` that `Chain.settle` consumes.
 */
export async function signAuthorization(account: PrivateKeyAccount, opts: SignAuthorizationOpts): Promise<Eip3009Auth> {
  const fields: AuthorizationFields = {
    from: account.address,
    to: opts.to,
    value: opts.value,
    validAfter: opts.validAfter ?? 0n,
    validBefore: opts.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 300),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signature = await account.signTypedData(authorizationTypedData(fields, opts.domain ?? USDC_DOMAIN));
  return {
    from: fields.from,
    to: fields.to,
    value: fields.value.toString(),
    validAfter: fields.validAfter.toString(),
    validBefore: fields.validBefore.toString(),
    nonce: fields.nonce,
    signature,
    token: opts.token ?? USDC_ADDRESS,
  };
}

export function authFields(auth: Eip3009Auth): AuthorizationFields {
  return {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };
}

/** Splits a 65-byte signature into (v, r, s) for the FiatTokenV2 `transferWithAuthorization(…, uint8 v, bytes32 r, bytes32 s)` overload. */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const sig = signature.slice(2);
  if (sig.length !== 130) throw new Error(`splitSignature: expected 65 bytes, got ${sig.length / 2}`);
  const r = `0x${sig.slice(0, 64)}` as Hex;
  const s = `0x${sig.slice(64, 128)}` as Hex;
  let v = parseInt(sig.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}
