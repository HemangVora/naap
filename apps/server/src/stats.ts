// The HUD numbers (world-v3 §HUD), computed from stored barrier results. Pure, no I/O.
import type { BarrierId, BarrierResult, Stats } from '@crumple/core';

export const ATTACK_LABELS: Partial<Record<BarrierId, string>> = {
  'grok-morse': 'Grok × Bankrbot Morse',
  freysa: 'Freysa pay() redefinition',
  'x402-swap': 'x402 payee swap',
};
const ATTACK_TYPES = Object.keys(ATTACK_LABELS) as BarrierId[];

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * - attacks: bare-lane attack steps per type; fooled = outcome CRASH. Sorted by fooled/attempts desc, then attempts desc
 *   (types never attempted sort last). Custom-incident results (incidentId) only borrow a preset skin, so they are
 *   left out of the preset labels; their losses still count.
 * - bareLossUsd / sekishoLossUsd: fork loss summed over every stored bare / airbag result.
 * - agentsTested: cars with a rating. tracks: tracks in the registry.
 */
export function computeStats(results: BarrierResult[], agentsTested: number, tracks: number): Stats {
  const per = new Map<BarrierId, { attempts: number; fooled: number }>(ATTACK_TYPES.map((t) => [t, { attempts: 0, fooled: 0 }]));
  let bareLoss = 0;
  let sekishoLoss = 0;
  for (const r of results) {
    if (r.variant === 'bare') {
      bareLoss += r.lossUsd;
      const a = r.incidentId ? undefined : per.get(r.barrierId);
      if (a) {
        a.attempts++;
        if (r.outcome === 'CRASH') a.fooled++;
      }
    } else sekishoLoss += r.lossUsd;
  }
  const ratio = (x: { attempts: number; fooled: number }) => (x.attempts ? x.fooled / x.attempts : -1);
  const attacks = [...per.entries()]
    .map(([type, a]) => ({ type, label: ATTACK_LABELS[type]!, attempts: a.attempts, fooled: a.fooled }))
    .sort((x, y) => ratio(y) - ratio(x) || y.attempts - x.attempts);
  const bareLossUsd = round2(bareLoss);
  const sekishoLossUsd = round2(sekishoLoss);
  return {
    agentsTested,
    attacksFaced: attacks.reduce((s, a) => s + a.attempts, 0),
    bareLossUsd,
    sekishoLossUsd,
    savedUsd: round2(bareLossUsd - sekishoLossUsd),
    attacks,
    tracks,
  };
}
