// One real step-up against the World sandbox: prints the approval URL + code, waits, prints the validated result.
// Run: pnpm --filter @crumple/world try            (reads WORLD_* from the environment or the repo-root .env)
//      pnpm --filter @crumple/world try -- --deny   (same, but you tap Deny in World App to see the DENIED path)
//      pnpm --filter @crumple/world try -- --ttl 45 (shorter wait, to show the EXPIRED path)
// Never prints the client secret or tokens.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STEPUP_TTL_OWNER_SEC } from '@crumple/core';
import { configFromEnv, createStepUp, isLive } from './stepup.js';

loadDotEnv();
const args = process.argv.slice(2);
const ttlSec = Number(argValue('--ttl') ?? STEPUP_TTL_OWNER_SEC);
const cfg = configFromEnv();

if (!isLive()) {
  console.error('WORLD_CLIENT_ID / WORLD_CLIENT_SECRET are not set — nothing to try. Register the app at https://sandbox.auth.world.org/portal (see docs/lanes/world.md).');
  process.exit(2);
}
console.log(`issuer      ${cfg.issuer}`);
console.log(`client_id   ${cfg.clientId}`);
console.log(`client auth ${cfg.authMethod}`);
console.log(`ttl         ${ttlSec} s`);

const stepUp = createStepUp(cfg);
const startedAt = Date.now();
const handle = await stepUp.request({
  carId: 'try',
  intentId: `try-${startedAt}`,
  summary: 'Pay $40 to compute.naap.eth for a 40-hour GPU block',
  ttlSec,
  allowApproval: true,
});

if (handle.verificationUri) {
  console.log('');
  console.log(`Open in a browser / scan:  ${handle.verificationUri}`);
  console.log(`User code:                 ${handle.userCode}`);
  console.log(`Expires at:                ${new Date(handle.expiresAt).toISOString()}`);
  console.log(args.includes('--deny') ? 'Now tap DENY in World App.' : 'Now prove with World App and tap APPROVE.');
  console.log('');
}

const tick = setInterval(() => {
  const left = Math.max(0, Math.round((handle.expiresAt - Date.now()) / 1000));
  process.stdout.write(`\r  waiting… ${left} s left   `);
}, 1000);
const result = await handle.result;
clearInterval(tick);
process.stdout.write('\r' + ' '.repeat(40) + '\r');

console.log(`status      ${result.status}`);
console.log(`detail      ${result.detail}`);
if (result.subject) console.log(`subject     ${result.subject.slice(0, 8)}…${result.subject.slice(-4)} (pairwise sub, truncated)`);
if (result.authTime) console.log(`auth_time   ${new Date(result.authTime * 1000).toISOString()} (${result.authTime - Math.floor(startedAt / 1000)} s after request)`);
console.log(`elapsed     ${Math.round((Date.now() - startedAt) / 1000)} s`);
console.log(result.status === 'APPROVED' ? 'Protected action would RUN.' : 'Protected action does NOT run.');
process.exit(result.status === 'APPROVED' ? 0 : 1);

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Minimal .env loader (repo root, then cwd) so the script works without extra deps. Existing env wins. */
function loadDotEnv() {
  for (const p of [resolve(process.cwd(), '../../.env'), resolve(process.cwd(), '.env')]) {
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
