// Base USDC (FiatTokenV2_2 behind a proxy) — addresses, ABI, EIP-712 domain, storage layout.
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

export const BASE_CHAIN_ID = 8453;
export const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;

/**
 * EIP-712 domain of Base USDC, verified against the live contract (`name()` = "USD Coin", `version()` = "2",
 * `DOMAIN_SEPARATOR()` matches `hashDomain` of these values). `readUsdcDomain()` re-verifies on the fork at boot.
 * The sekisho signer must use exactly this domain for `transferWithAuthorization`.
 */
export const USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_ADDRESS,
} as const;

/** EIP-3009 typed-data types (Circle FiatTokenV2). */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * FiatToken storage: slot 9 holds `mapping(address => uint256) balanceAndBlacklistStates` (v2.2; earlier
 * versions call it `balances`). Layout: 0 _owner · 1 pauser|paused · 2 blacklister · 3 blacklisted · 4 name ·
 * 5 symbol · 6 decimals · 7 currency · 8 masterMinter|initialized · 9 balances. In v2.2 the top bit of the
 * balance word is the blacklist flag, so any value < 2^255 is "not blacklisted, balance = value".
 */
export const USDC_BALANCE_SLOT = 9n;

/** Storage key of `balances[holder]` (Solidity mapping: keccak256(abi.encode(key, slot))). */
export function usdcBalanceSlot(holder: Address, slot: bigint = USDC_BALANCE_SLOT): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]));
}

/** USD → USDC base units (6 dp), rounded to the nearest unit. */
export function usdToUnits(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`usdToUnits: bad amount ${usd}`);
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}
export function unitsToUsd(units: bigint): number {
  return Number(units) / 10 ** USDC_DECIMALS;
}

export const USDC_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** Minimal ERC-20 ABI (DRB and any other plain token). */
export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;
