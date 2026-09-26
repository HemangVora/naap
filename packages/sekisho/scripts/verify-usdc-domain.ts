// Reads the EIP-712 domain of Base USDC from the real contract (BASE_RPC_URL) and compares it
// with what the signer uses. Never prints the RPC URL. Run: pnpm --filter @crumple/sekisho exec tsx scripts/verify-usdc-domain.ts
import { readFileSync, existsSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { USDC_DOMAIN } from '../src/signer.js';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  const p = new URL('../../../.env', import.meta.url).pathname;
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    if (!out[k]) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

async function main() {
  const url = loadEnv().BASE_RPC_URL;
  if (!url) {
    console.log('BASE_RPC_URL not set — skipping live domain check');
    return;
  }
  const c = createPublicClient({ chain: base, transport: http(url, { timeout: 15_000 }) });
  const abi = parseAbi(['function name() view returns (string)', 'function version() view returns (string)']);
  try {
    const [name, version] = await Promise.all([
      c.readContract({ address: USDC_DOMAIN.verifyingContract, abi, functionName: 'name' }),
      c.readContract({ address: USDC_DOMAIN.verifyingContract, abi, functionName: 'version' }),
    ]);
    const ok = name === USDC_DOMAIN.name && version === USDC_DOMAIN.version;
    console.log(JSON.stringify({ onchain: { name, version }, signer: { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version }, match: ok }));
    if (!ok) process.exitCode = 1;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('rpc failed: ' + msg.replace(url, '<BASE_RPC_URL>').slice(0, 200));
    process.exitCode = 1;
  }
}
main();
