// World FX bus: the scene lane emits what happens, the audio/nav lane listens.
// Keep payloads plain; positions are world-space.
import type { BarrierId, Variant } from '../types';

export type Biome = 'meadow' | 'storm-ridge' | 'caldera' | 'river-canyon' | 'rockfall-pass';

export type FxEvent =
  | { t: 'engine'; carId: string; variant: Variant; x: number; y: number; z: number; speed: number } // throttled ~10 Hz per car
  | { t: 'crash'; carId: string; kind: 'wall' | 'cliff-fall' | 'lava' | 'water' | 'rockfall'; x: number; y: number; z: number; lossUsd: number }
  | { t: 'aeb'; carId: string; x: number; y: number; z: number } // hard braking stop at a Sekisho gate
  | { t: 'gate'; state: 'open' | 'close' | 'amber'; x: number; y: number; z: number }
  | { t: 'splash'; x: number; y: number; z: number }
  | { t: 'sizzle'; x: number; y: number; z: number }
  | { t: 'thunder'; x: number; y: number; z: number }
  | { t: 'report'; carId: string }
  | { t: 'enter-biome'; biome: Biome; type: BarrierId }; // the local player walked into a biome

type Fn = (e: FxEvent) => void;
const fns = new Set<Fn>();
export const fx = {
  emit(e: FxEvent) {
    for (const f of fns) {
      try {
        f(e);
      } catch (err) {
        console.warn('[fx]', err);
      }
    }
  },
  on(f: Fn) {
    fns.add(f);
    return () => fns.delete(f);
  },
};

/** Which biome each obstacle type lives in (see docs/design/world-v4.md). */
export const BIOME_FOR: Record<BarrierId, Biome> = {
  legit: 'meadow',
  'grok-morse': 'storm-ridge',
  freysa: 'caldera',
  'x402-swap': 'river-canyon',
  'over-limit': 'rockfall-pass',
};
