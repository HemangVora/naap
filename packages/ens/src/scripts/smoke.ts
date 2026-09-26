// End-to-end on Sepolia: create a test car subname + mandate, read it back through the UniversalResolver,
// write a rating, prove the agent cannot edit. Prints Etherscan links.
//   pnpm --filter @crumple/ens smoke [carId] [--send]
import { PAYEE_ENS, type Rating } from '@crumple/core';
import { agentAccountFor } from '../local.js';
import { createEnsRatingWriter } from '../rating.js';
import { ALL_TEXT_KEYS, carEnsName } from '../records.js';
import { ensLink, ensureRelayer, flag, positional, requireFunded, say, sourceFor, txLink } from './common.js';

const carId = positional()[0] ?? `smoke-${Date.now().toString(36).slice(-5)}`;
const ensName = carEnsName(carId);
const { relayer, env } = ensureRelayer();
await requireFunded(relayer, 5_000_000_000_000_000n);
const src = sourceFor(relayer, env);
const lay = await src.probe();
say(`layout: UserRegistry ${lay.userRegistry}  resolver ${lay.resolver}`);

// The agent's own address is the token owner: it owns its name but holds no roles.
const agent = agentAccountFor(carId, env.agentSeed);
const t0 = Date.now();
const immediate = await src.createForCar(carId, agent.address);
say(`createForCar returned in ${Date.now() - t0}ms: source=${immediate.source} payees=${immediate.payees.map((p) => `${p.ens}→${p.address}`).join(',')}`);
const hash = await src.whenConfirmed(ensName);
say(`mandate on-chain ${txLink(hash)}`);

const m = await src.get(ensName);
say(`get(${ensName}) source=${m.source} owner=${m.owner} perTx=$${m.perTxCapUsd} daily=${m.dailyCapBps}bps expires=${new Date(m.expiresAt * 1000).toISOString()}`);
for (const p of m.payees) say(`  payee ${p.ens} → ${p.address}`);
const payee = await src.resolve(PAYEE_ENS);
say(`resolve(${PAYEE_ENS}) = ${payee ?? 'null (run seed-payee)'}`);

const rating: Rating = { stars: 5, bare: { stars: 1, lossUsd: 451.99, crashes: 2 }, airbag: { stars: 5, lossUsd: 0, crashes: 0 } };
const rw = createEnsRatingWriter(src);
const confirmed = new Promise<string>((r) => rw.onConfirmed((_c, h) => r(h)));
rw.enqueue(carId, ensName, rating);
await rw.idle();
if (rw.errors.has(carId)) say(`rating write FAILED: ${rw.errors.get(carId)}`);
else say(`rating on-chain ${txLink((await confirmed) as `0x${string}`)}`);

const records = await src.readRecords(ensName, ALL_TEXT_KEYS);
for (const [k, v] of Object.entries(records)) say(`  ${k} = ${v}`);

const proof = await src.proveAgentCannotEdit(ensName, { send: flag('send'), fund: flag('send') });
say(`proveAgentCannotEdit: rejected=${proof.rejected}`);
say(`  ${proof.detail}`);
if (proof.txHash) say(`  ${txLink(proof.txHash)}`);
say('');
say(`ENS app: ${ensLink(ensName)}`);
process.exit(m.source === 'ens' && proof.rejected && !rw.errors.size ? 0 : 1);
