// Shared bits for the live scripts. Never prints a private key or the .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther } from 'viem';
import type { Address, Hex } from '@crumple/core';
import { ENS_APP, ETHERSCAN } from '../addresses.js';
import { createEnsMandateSource, type EnsMandateSource } from '../ens.js';
import { ensEnv, type EnsEnv } from '../env.js';
import { createRelayer, newRelayerKey, type Relayer } from '../relayer.js';
import { PARENT_LABEL } from '../records.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../../..');
export const ENV_PATH = resolve(REPO_ROOT, '.env');
/** One state file per parent (deployment.naap.sepolia.json, deployment.crumple.sepolia.json, …). ENS_STATE_PATH overrides (fork dry-runs). */
export const STATE_PATH = process.env.ENS_STATE_PATH || resolve(here, `../../deployment.${PARENT_LABEL}.sepolia.json`);

export const say = (...a: unknown[]) => console.log(...a);
export const txLink = (h: Hex) => `${ETHERSCAN}/tx/${h}`;
export const addrLink = (a: Address) => `${ETHERSCAN}/address/${a}`;
export const ensLink = (name: string) => `${ENS_APP}/${name}`;

export interface DeployState {
  relayer?: Address;
  userRegistry?: Address;
  resolver?: Address;
  commitment?: { hash: Hex; secret: Hex; label: string; owner: Address; subregistry: Address; resolver: Address; duration: string; committedAt?: number; tx?: Hex };
  registerTx?: Hex;
  grantsTx?: Hex;
  payee?: { address: Address; tx?: Hex };
  updatedAt?: string;
}

export function loadState(): DeployState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as DeployState;
  } catch {
    return {};
  }
}
export function saveState(s: DeployState) {
  s.updatedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

/** Ensures RELAYER_PK exists (generating one into .env if not) and returns the relayer. The key is never printed. */
export function ensureRelayer(): { relayer: Relayer; env: EnsEnv; generated: boolean } {
  let env = ensEnv();
  let generated = false;
  if (!env.relayerPk) {
    const pk = newRelayerKey();
    writeEnvVar('RELAYER_PK', pk);
    process.env.RELAYER_PK = pk;
    generated = true;
    env = ensEnv();
  }
  if (!env.rpcUrl) {
    say('SEPOLIA_RPC_URL is not set in .env — add one (e.g. https://ethereum-sepolia-rpc.publicnode.com) and rerun.');
    process.exit(2);
  }
  const relayer = createRelayer({ rpcUrl: env.rpcUrl, privateKey: env.relayerPk!, log: (l) => say(`  · ${l}`) });
  if (generated) say(`Generated a new relayer key → written to .env as RELAYER_PK (not shown). Relayer address: ${relayer.address}`);
  return { relayer, env, generated };
}

function writeEnvVar(name: string, value: string) {
  const line = `${name}=${value}`;
  let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, line);
  else text = text.replace(/\n?$/, '\n') + line + '\n';
  writeFileSync(ENV_PATH, text, { mode: 0o600 });
}

/** Exits with the exact human steps when the relayer has no Sepolia ETH. */
export async function requireFunded(relayer: Relayer, minWei = 30_000_000_000_000_000n /* 0.03 ETH */): Promise<bigint> {
  const bal = await relayer.publicClient.getBalance({ address: relayer.address });
  say(`Relayer ${relayer.address} — ${formatEther(bal)} Sepolia ETH (${addrLink(relayer.address)})`);
  if (bal < minWei) {
    say('');
    say('HUMAN ACTION NEEDED — the relayer has no Sepolia ETH. Do this, then rerun the same command:');
    say(`  1. Send ≥ 0.1 Sepolia ETH to ${relayer.address}`);
    say('     faucets: https://cloud.google.com/application/web3/faucet/ethereum/sepolia · https://www.alchemy.com/faucets/ethereum-sepolia · https://sepoliafaucet.com');
    say('     (or from any wallet that already holds Sepolia ETH)');
    say('  2. rerun: pnpm --filter @crumple/ens register   (ENS_PARENT=<label>.eth to target another parent)');
    say('  Registration itself is paid in MockUSDC (minted for free); ETH is only for gas. ~1.5M gas total.');
    process.exit(2);
  }
  return bal;
}

export function sourceFor(relayer: Relayer, env: EnsEnv): EnsMandateSource {
  return createEnsMandateSource({ rpcUrl: env.rpcUrl!, relayerPk: env.relayerPk!, log: relayer.log, agentSeed: env.agentSeed, userRegistry: env.userRegistry, resolver: env.resolver });
}

export const flag = (name: string) => process.argv.includes(`--${name}`);
export const positional = () => process.argv.slice(2).filter((a) => !a.startsWith('--'));
