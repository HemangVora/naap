// Read a car's mandate and NCAP rating straight from ENSv2 Sepolia via the UniversalResolver.
// The public ENS app (sepolia.app.ens.domains) still reads the v1 registry, so it shows no records for *.naap.eth.
// Usage: pnpm --filter @crumple/ens read-name demo-wallet-y54i47.naap.eth
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { ENSV2 } from '../addresses.js';

const KEYS = [
  'sekisho.payees', 'sekisho.perTxCapUsd', 'sekisho.dailyCapBps', 'sekisho.expiresAt',
  'naap.stars', 'naap.summary', 'naap.bareLossUsd', 'naap.airbagLossUsd', 'naap.runAt',
] as const;

const name = process.argv[2] ?? 'naap-demo.naap.eth';
const pc = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });

console.log(`${name}  (ENSv2 Sepolia, UniversalResolver ${ENSV2.universalResolver})`);
for (const key of KEYS) {
  const value = await pc.getEnsText({ name, key, universalResolverAddress: ENSV2.universalResolver }).catch(() => null);
  if (value !== null) console.log(`  ${key.padEnd(22)} ${value}`);
}
