// `pnpm --filter @crumple/intercepta probe` — live check of the address picks.
// Scans ATTACKER_CANDIDATES + WEATHER (Quick Scan) and Base USDC (Scan Token), prints verdicts and reasons,
// writes evidence to data/intercepta-probe.json (which addresses.ts reads to set `verified`), reports the budget.
// Loads .env via `tsx --env-file`. Never prints the key.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ATTACKER_CANDIDATES, BASE_CHAIN_ID, TOKEN_PICK, WEATHER_PICK, type AddressPick, type ProbeFile } from './addresses.js';
import { createScreener, type InterceptaScreenResult } from './screener.js';
import { DEFAULT_PROBE_PATH } from './store.js';

const hasKey = Boolean(process.env.INTERCEPTA_API_KEY?.trim());
const hasSeed = Boolean(process.env.WEATHER_SEED);
console.log(`intercepta probe · key: ${hasKey ? 'present' : 'MISSING'} · WEATHER_SEED: ${hasSeed ? 'set' : 'unset (dev seed)'}`);
if (!hasKey) {
  console.log('No INTERCEPTA_API_KEY — nothing to verify. Set it in .env and rerun. (Not writing probe evidence.)');
  process.exit(0);
}

const screener = createScreener();
const before = screener.budget();

type Role = ProbeFile['picks'][number]['role'];
const rows: (AddressPick & { role: Role })[] = [];

function line(role: Role, pick: AddressPick, r: InterceptaScreenResult) {
  const tag = r.source === 'live' ? 'LIVE' : r.source === 'cache' ? 'CACHE' : `OFFLINE(${r.error ?? r.source})`;
  console.log(`${role.padEnd(8)} ${pick.address}  ${r.verdict.padEnd(5)} score=${String(r.toxicScore).padEnd(3)} [${tag}] ${r.reason}`);
  for (const t of r.traits.slice(1, 4)) console.log(`           · ${t.name}: ${t.description}`);
}

async function probeOne(role: Role, pick: AddressPick, want: 'PASS' | 'BLOCK', scan: () => Promise<InterceptaScreenResult>) {
  const r = await scan();
  line(role, pick, r);
  const seen = r.live;
  const ok = want === 'BLOCK' ? r.verdict !== 'PASS' : r.verdict === 'PASS';
  rows.push({
    ...pick,
    role,
    verified: seen && ok,
    evidence: seen ? { verdict: r.verdict, toxicScore: r.toxicScore, reason: r.reason, at: Date.now() } : undefined,
  });
  return r;
}

for (const c of ATTACKER_CANDIDATES) await probeOne('attacker', c, 'BLOCK', () => screener.quickScan(c.address));
await probeOne('weather', WEATHER_PICK, 'PASS', () => screener.quickScan(WEATHER_PICK.address));
await probeOne('token', TOKEN_PICK, 'PASS', () => screener.scanToken(TOKEN_PICK.address, BASE_CHAIN_ID));

const after = screener.budget();
const anyLive = rows.some((r) => r.evidence);
const out: ProbeFile = { at: Date.now(), live: anyLive, budget: { used: after.used, ceiling: after.ceiling, remaining: after.remaining }, picks: rows };
mkdirSync(dirname(DEFAULT_PROBE_PATH), { recursive: true });
writeFileSync(DEFAULT_PROBE_PATH, JSON.stringify(out, null, 2) + '\n');

const flagged = rows.filter((r) => r.role === 'attacker' && r.verified);
console.log('');
console.log(`attackers flagged: ${flagged.length}/${ATTACKER_CANDIDATES.length} → ATTACKERS = [${flagged.slice(0, 2).map((r) => r.address).join(', ')}]`);
console.log(`weather PASS: ${rows.find((r) => r.role === 'weather')?.verified ? 'yes' : 'NO'} · USDC PASS: ${rows.find((r) => r.role === 'token')?.verified ? 'yes' : 'NO'}`);
console.log(`budget: used ${after.used}/${after.ceiling} (this run: +${after.used - before.used}) · evidence → ${DEFAULT_PROBE_PATH}`);
if (flagged.length < 2) {
  console.log('WARNING: fewer than 2 attacker candidates flagged — add candidates to ATTACKER_CANDIDATES and rerun.');
  process.exit(1);
}
