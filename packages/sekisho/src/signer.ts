// Signer — the only key holder. Keys: keccak256(seed ‖ carId ‖ variant) per (car, variant).
// Signs EIP-3009 transferWithAuthorization for Base USDC. Never imported by the planner, reader or drivers.
import type { Address, Eip3009Auth, Hex, Mandate, PaymentIntent, Signer, StepUpResult, Variant, Verdict } from '@crumple/core';
import { randomBytes } from 'node:crypto';
import { concat, keccak256, stringToBytes, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { sameAddress, short, usd } from './util.js';

/** Verified against the live contract on Base (scripts/verify-usdc-domain.ts): name "USD Coin", version "2". */
export const USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
} as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** What verifyTypedData needs to check an auth we produced. */
export function typedDataFor(auth: Omit<Eip3009Auth, 'signature'>) {
  return {
    domain: USDC_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  };
}

export interface SignerOptions {
  seed: string;
  /** unix seconds, for tests */
  now?: () => number;
  /** how long an authorization stays valid (default 10 min) */
  validForSec?: number;
}

const AMOUNT_LABELS_OK = new Set(['OWNER', 'MANDATE', 'OWNER_BOUNDED']);
const REFUSING = new Set(['PROVENANCE_AMOUNT', 'PROVENANCE_PAYEE', 'TAINT', 'MANDATE_PAYEE', 'MANDATE_EXPIRED', 'INTERCEPTA']);

export class SignerRefused extends Error {}

export function createSigner(opts: SignerOptions): Signer {
  if (!opts.seed) throw new Error('createSigner: seed is required (SIGNER_SEED)');
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const validFor = opts.validForSec ?? 600;
  const accounts = new Map<string, PrivateKeyAccount>();

  function accountFor(carId: string, variant: Variant): PrivateKeyAccount {
    const key = `${carId}\u0000${variant}`;
    let acc = accounts.get(key);
    if (!acc) {
      const pk = keccak256(concat([stringToBytes(opts.seed), stringToBytes('\u0000'), stringToBytes(carId), stringToBytes('\u0000'), stringToBytes(variant)]));
      acc = privateKeyToAccount(pk);
      accounts.set(key, acc);
    }
    return acc;
  }

  return {
    walletFor(carId, variant) {
      return accountFor(carId, variant).address;
    },

    async authorize(intent: PaymentIntent, verdict: Verdict, mandate: Mandate, stepUp?: StepUpResult) {
      const bare = intent.mode === 'bare';
      if (!bare) recheck(intent, verdict, mandate, stepUp, now());
      if (intent.token !== 'USDC') throw new SignerRefused(`signer: ${intent.token} raw transfers are not supported yet (USDC via EIP-3009 only)`);

      const account = accountFor(intent.carId, bare ? 'bare' : 'airbag');
      const auth: Omit<Eip3009Auth, 'signature'> = {
        from: account.address,
        to: intent.payTo.value,
        value: BigInt(Math.round(intent.amountUsd.value * 1e6)).toString(),
        validAfter: '0',
        validBefore: String(now() + validFor),
        nonce: toHex(randomBytes(32)) as Hex,
        token: USDC_DOMAIN.verifyingContract,
      };
      const signature = await account.signTypedData(typedDataFor(auth));
      return { ...auth, signature };
    },
  };
}

/** Independent of policy: the signer re-derives "may this move money?" from the intent + mandate + step-up alone. */
function recheck(intent: PaymentIntent, verdict: Verdict, mandate: Mandate, stepUp: StepUpResult | undefined, now: number): void {
  const approved = stepUp?.status === 'APPROVED';
  const allowed = verdict.decision === 'PAY' || (verdict.decision === 'STEP_UP' && approved);
  if (!allowed) throw new SignerRefused(`signer refuses: verdict is ${verdict.decision}${verdict.decision === 'STEP_UP' ? ` and step-up is ${stepUp?.status ?? 'missing'}` : ''} — ${verdict.reason}`);
  const badCheck = verdict.checks.find((c) => !c.ok && REFUSING.has(c.control));
  if (badCheck) throw new SignerRefused(`signer refuses: verdict carries a failed ${badCheck.control} — ${badCheck.detail}`);

  const payTo = intent.payTo.value;
  const payee = mandate.payees.find((p) => sameAddress(p.address, payTo));
  if (!payee && !approved) throw new SignerRefused(`signer refuses: ${short(payTo)} is not a mandate payee and no owner approval was given`);
  const amount = intent.amountUsd.value;
  if (!(Number.isFinite(amount) && amount >= 0)) throw new SignerRefused(`signer refuses: bad amount ${String(amount)}`);
  if (amount > mandate.perTxCapUsd && !approved) throw new SignerRefused(`signer refuses: ${usd(amount)} is over the ${usd(mandate.perTxCapUsd)} cap and no owner approval was given`);
  if (now >= mandate.expiresAt) throw new SignerRefused(`signer refuses: mandate for ${mandate.ensName} has expired`);

  if (intent.mode === 'full') {
    if (intent.payTo.label !== 'TOOL') throw new SignerRefused(`signer refuses: payee ${short(payTo)} is ${intent.payTo.label}, not resolved by our own code`);
    if (!AMOUNT_LABELS_OK.has(intent.amountUsd.label)) throw new SignerRefused(`signer refuses: amount ${usd(amount)} is ${intent.amountUsd.label}`);
    if (payee && intent.payeeEns && intent.payeeEns.value.toLowerCase() !== payee.ens.toLowerCase())
      throw new SignerRefused(`signer refuses: intent says ${intent.payeeEns.value} but ${short(payTo)} is ${payee.ens}`);
  }
}
