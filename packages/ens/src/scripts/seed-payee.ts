// compute.naap.eth → address (arg or PAYEE_ADDRESS). Registers the subname if needed and sets the addr record.
import { PAYEE_ENS, type Address } from '@crumple/core';
import { seedPayee } from '../seed.js';
import { ensLink, ensureRelayer, loadState, positional, requireFunded, saveState, say, sourceFor, txLink } from './common.js';

const arg = positional()[0] ?? process.env.PAYEE_ADDRESS ?? process.env.WEATHER_ADDRESS;
if (!arg || !/^0x[0-9a-fA-F]{40}$/.test(arg)) {
  say('usage: pnpm --filter @crumple/ens seed-payee 0x<compute payee address>   (or set PAYEE_ADDRESS in .env)');
  process.exit(2);
}
const { relayer, env } = ensureRelayer();
await requireFunded(relayer, 5_000_000_000_000_000n);
const src = sourceFor(relayer, env);
const w = await seedPayee(src, arg as Address);
const state = loadState();
state.payee = { address: arg as Address, tx: w.addrTx ?? state.payee?.tx };
saveState(state);
say(`${PAYEE_ENS} → ${w.resolved}  ${ensLink(PAYEE_ENS)}`);
if (w.registerTx) say(`  register ${txLink(w.registerTx)}`);
if (w.addrTx) say(`  setAddress ${txLink(w.addrTx)}`);
if (!w.resolved || w.resolved.toLowerCase() !== arg.toLowerCase()) {
  say('WARNING: UniversalResolver does not yet return the new address (RPC lag?) — re-check in a minute.');
  process.exit(1);
}
