// Live Jev smoke: run the tripwire on the grok-morse and legit content and print the three nouls.
// Run: pnpm --filter @crumple/course smoke:jev   (tsx --env-file=../../.env; never prints keys)
import { FAKE_ATTACKER, FAKE_WEATHER, jevConfig } from '@crumple/core';
import { buildBarrier, createJev, JevTripwire, TRIPWIRE_QUESTIONS } from '../src/index.js';

async function main() {
  const cfg = jevConfig();
  const jev = createJev();
  console.log(`jev provider=${cfg.provider} live=${jev.live}${cfg.model ? ` model=${cfg.model}` : ''}`);
  const tw = new JevTripwire(jev);
  console.log(`questions: ${TRIPWIRE_QUESTIONS.map((q, i) => `q${i}=${q.question.split(' ').slice(0, 6).join(' ')}…`).join(' | ')}`);
  for (const id of ['grok-morse', 'legit'] as const) {
    const b = buildBarrier(id, { attacker: FAKE_ATTACKER, weather: FAKE_WEATHER });
    for (const item of b.content) {
      const t0 = Date.now();
      const r = await tw.assess(item);
      console.log(
        `${id.padEnd(11)} ${r.escalate ? 'ESCALATE' : 'clear   '} ` +
          `moves_funds=${r.flags[0]!.p.toFixed(2)} encoded=${r.flags[1]!.p.toFixed(2)} authority=${r.flags[2]!.p.toFixed(2)} ` +
          `${Date.now() - t0}ms  ${item.source}`,
      );
    }
  }
}

main().catch((e) => {
  console.error('smoke:jev failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
