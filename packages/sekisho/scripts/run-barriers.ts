// Drives the five barriers through Sekisho with core fakes for everything except the LLM.
//   pnpm --filter @crumple/sekisho exec tsx scripts/run-barriers.ts           # scripted LLM (offline)
//   pnpm --filter @crumple/sekisho exec tsx --env-file=../../.env scripts/run-barriers.ts --live [--only=legit]   # real claude-sonnet-5 / haiku-4-5 (ANTHROPIC_API_KEY or OPENROUTER_API_KEY)
// Prints the trace exactly as the arena would show it. Never prints secrets.
import { existsSync, readFileSync } from 'node:fs';
import { BARRIER_ORDER, FakeMandateSource, FakeScreener, FakeTripwire, GullibleDriver } from '@crumple/core';
import { AnthropicLlmClient, llmFromEnv } from '../src/llm.js';
import { createSekisho } from '../src/sekisho.js';
import { barriers, car, mandateFor, scriptedLlm, session } from '../src/test-fixtures.js';

function loadDotenv() {
  const p = new URL('../../../.env', import.meta.url).pathname;
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
  }
}

async function main() {
  const live = process.argv.includes('--live');
  const boundary = process.argv.includes('--boundary');
  if (live) loadDotenv();
  const llm = live ? llmFromEnv() : scriptedLlm();
  if (live && !llm.live) {
    console.log('no LLM credentials (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — cannot run --live');
    process.exitCode = 1;
    return;
  }
  const mandates = new FakeMandateSource();
  const mandate = await mandateFor(mandates);
  const sekisho = createSekisho({ mandates, screener: new FakeScreener(), tripwire: new FakeTripwire(), llm });
  console.log(`mode: ${boundary ? 'boundary (GullibleDriver)' : 'full'} · llm: ${llm.live ? `${llm.plannerModel} / ${llm.readerModel}` : 'scripted (offline)'}\n`);
  const summary: string[] = [];

  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  for (const id of BARRIER_ORDER) {
    if (only && id !== only) continue;
    const obs = barriers[id];
    const t0 = Date.now();
    const out = boundary
      ? await sekisho.runBoundary(car, obs, await new GullibleDriver().act(obs), mandate, session(id))
      : await sekisho.runBuilt(car, car.spec.persona ?? '', obs, mandate, session(id));
    console.log(`━━ ${id.toUpperCase()}  (${Date.now() - t0} ms)`);
    console.log(`   owner: ${obs.ownerRequest}`);
    for (const t of out.trace) console.log(`   ${t.who.padEnd(11)} ${t.text}`);
    out.verdicts.forEach((v, i) => console.log(`   ▶ ${v.decision.padEnd(7)} [${v.blockedBy.join(', ') || '—'}]  ${v.reason}  (intent ${out.intents[i].id})`));
    if (!out.intents.length) console.log('   ▶ no intent — nothing paid');
    console.log();
    const ms = Date.now() - t0;
    summary.push(`${id.padEnd(11)} ${ms.toString().padStart(6)} ms  ${out.verdicts.map((v) => `${v.decision}${v.blockedBy[0] ? ` (${v.blockedBy[0]})` : ''}`).join(' | ') || 'no intent'}`);
  }
  console.log('━━ SUMMARY');
  for (const l of summary) console.log(`   ${l}`);
  if (llm instanceof AnthropicLlmClient) console.log(`   json mode: planner=${llm.jsonMode(llm.plannerModel) ?? '?'} reader=${llm.jsonMode(llm.readerModel) ?? '?'} (provider ${llm.provider})`);
}
main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e).slice(0, 300));
  process.exitCode = 1;
});
