// ENSv2 Sepolia — 2026-09-15 redeploy.
// Source: ensdomains/contracts-v2 `contracts/deployments/sepolia/addresses.md` @ 71a3b733
// (also docs.ens.domains/learn/deployments). Do NOT take addresses from contracts-v2 `main` — they are stale.
import type { Address } from '@crumple/core';

export const SEPOLIA_CHAIN_ID = 11155111;

export const ENSV2 = {
  ethRegistrar: '0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca',
  ethRegistry: '0x657ea849311d3d5823348dded7c2aaafb3ede09e',
  rootRegistry: '0x9703dbd26dab89504490994138cf2c575251a9ce',
  rentPriceOracle: '0x9b0b9c65bdaf9794ff7697e4dcfb1f50581072bb',
  mockUsdc: '0x16f95d91dba7da3aca778ec053df0ff6c6a8aa8e',
  verifiableFactory: '0x9e726eb570beb6bceb495ab8cda7df517d4e841c',
  userRegistryImpl: '0xa80338aaa8d23831cea25e858d1774534abb0263',
  permissionedResolverImpl: '0x14f09fd05d4585759e54844dc9b00147131cf243',
  universalResolver: '0x5d25c1d6acbb71b7a28aa7899618a3412a8303e3',
  universalResolverProxy: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
} as const satisfies Record<string, Address>;

export const ETHERSCAN = 'https://sepolia.etherscan.io';
export const ENS_APP = 'https://sepolia.app.ens.domains';

// ─── EnhancedAccessControl roles (nybble-packed; admin = role << 128) ────────
// contracts/src/registry/libraries/RegistryRolesLib.sol
const admin = (r: bigint) => r << 128n;
export const REGISTRY_ROLES = {
  REGISTRAR: 1n << 0n,
  REGISTER_RESERVED: 1n << 4n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  SET_URI: 1n << 36n,
  UPGRADE: 1n << 124n,
} as const;

// contracts/src/resolver/libraries/PermissionedResolverLib.sol
export const RESOLVER_ROLES = {
  SET_ADDRESS: 1n << 0n,
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  SET_ABI: 1n << 12n,
  SET_INTERFACE: 1n << 16n,
  SET_NAME: 1n << 20n,
  SET_DATA: 1n << 24n,
  LINK: 1n << 28n,
  UPGRADE: 1n << 124n,
} as const;

const withAdmin = (...roles: bigint[]) => roles.reduce((acc, r) => acc | r | admin(r), 0n);

/** Root roles the relayer holds on the naap.eth UserRegistry (can register/renew/unregister car subnames, set their resolvers). */
export const RELAYER_REGISTRY_ROLES = withAdmin(
  REGISTRY_ROLES.REGISTRAR,
  REGISTRY_ROLES.REGISTER_RESERVED,
  REGISTRY_ROLES.SET_PARENT,
  REGISTRY_ROLES.UNREGISTER,
  REGISTRY_ROLES.RENEW,
  REGISTRY_ROLES.SET_SUBREGISTRY,
  REGISTRY_ROLES.SET_RESOLVER,
  REGISTRY_ROLES.SET_URI,
  REGISTRY_ROLES.UPGRADE,
);

/**
 * Root roles the relayer holds on the PermissionedResolver. Deliberately NOT root ROLE_SET_TEXT:
 * text writes are granted per key (sekisho.* / naap.*) via grantSetterRoles, using SET_TEXT_ADMIN.
 */
export const RELAYER_RESOLVER_ROLES =
  withAdmin(REGISTRY_ROLES.UPGRADE, RESOLVER_ROLES.SET_ADDRESS, RESOLVER_ROLES.SET_NAME, RESOLVER_ROLES.LINK, RESOLVER_ROLES.SET_CONTENTHASH) |
  admin(RESOLVER_ROLES.SET_TEXT) |
  admin(RESOLVER_ROLES.SET_DATA);

export const ROLE_NAMES: Record<string, string> = {
  [RESOLVER_ROLES.SET_TEXT.toString()]: 'ROLE_SET_TEXT',
  [RESOLVER_ROLES.SET_ADDRESS.toString()]: 'ROLE_SET_ADDRESS',
  [REGISTRY_ROLES.REGISTRAR.toString()]: 'ROLE_REGISTRAR',
  [REGISTRY_ROLES.SET_RESOLVER.toString()]: 'ROLE_SET_RESOLVER',
  [REGISTRY_ROLES.SET_SUBREGISTRY.toString()]: 'ROLE_SET_SUBREGISTRY',
};

/** ETHRegistrar constants read live on 2026-09-26 (MIN_COMMITMENT_AGE=60, MAX=86400, MIN_REGISTER_DURATION=28d). */
export const REGISTRAR = {
  minCommitmentAgeSec: 60,
  maxCommitmentAgeSec: 86400,
  minDurationSec: 28 * 86400,
  /** naap.eth registration + car subname expiry. */
  durationSec: 365 * 86400,
} as const;
