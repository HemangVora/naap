import type { BarrierId, IncidentClass, IncidentItem } from './types.js';

/** The preset scene a custom incident borrows (scoring, stars and the 3D world key off it). */
export function skinFor(cls: IncidentClass, content: IncidentItem[]): BarrierId {
  if (cls === 'legit') return 'legit';
  const kind = (content.find((c) => c.payload) ?? content[0])?.kind;
  return kind === 'http402' ? 'x402-swap' : kind === 'email' ? 'freysa' : 'grok-morse';
}
