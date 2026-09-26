// Biome geometry contract (track-local frame: road along +x at y = 0, slot-0 Sekisho lane z = 0, bare lane z = −3.7,
// the far verge / hazard side is −z). Everything is relative to a station x `sx` (the gate / barrier x of that obstacle).
// Terrain (biomes/terrain.ts) and the death sims (sims/deaths.ts) both read these, so the car falls where the hole is.
import type { BarrierId } from '../../types';

export type CrashKind = 'wall' | 'cliff-fall' | 'lava' | 'water' | 'rockfall';

/** Bare-lane CRASH on these obstacles is a biome death instead of the v2 wall crash. */
export const DEATH_FOR: Partial<Record<BarrierId, CrashKind>> = {
  'grok-morse': 'cliff-fall',
  freysa: 'lava',
  'x402-swap': 'water',
};

/** Plateau: every plot stands on a mesa at y = 0 that spans z ∈ [PLATEAU_Z0, PLATEAU_Z1]; the lowland is at VALLEY_Y. */
export const PLATEAU_Z0 = -24;
export const PLATEAU_Z1 = 24;
export const VALLEY_Y = -34;

/** Segment of obstacle i along x: [sx + SEG_A, sx + SEG_B] (clamped by the neighbours' stations). */
export const SEG_A = -12;

// ── Signal Ridge: the ground ends at CLIFF_Z (a sheer drop), guard rail at RAIL_Z, scree floor at CLIFF_FLOOR_Y ──
export const RAIL_Z = -6.9;
export const CLIFF_Z = -7.6;
export const CLIFF_FLOOR_Y = -16;
/** where a car that goes over comes to rest (dx from sx, z) */
export const CLIFF_REST = { dx: 9, z: -15.5 };
/** cliff opening spans x ∈ [sx + CLIFF_X0, sx + CLIFF_X1] */
export const CLIFF_X0 = -4;
export const CLIFF_X1 = 16;

// ── Treasure Caldera: lava lake on −z, "receive the prize" ramp from the road edge out over the lava ──
export const LAVA_Y = -2.6;
export const LAVA_X0 = -6;
export const LAVA_X1 = 16;
export const LAVA_Z0 = -23; // far shore
export const LAVA_Z1 = -7.4; // near shore (road side)
/** ramp: starts at the road edge, climbs to RAMP_TOP_Y and ends in the air over the lava */
export const RAMP_START = { dx: 1.5, z: -6.2 };
export const RAMP_END = { dx: 7.5, z: -11.5 };
export const RAMP_TOP_Y = 1.6;
/** vault island centre */
export const VAULT = { dx: 9, z: -17.5 };

// ── River Canyon: a river gorge crosses the whole plot (flows along z) between x ∈ [sx + RIVER_X0, sx + RIVER_X1] ──
export const RIVER_X0 = 5;
export const RIVER_X1 = 14;
export const WATER_Y = -7;
/** the real bridge carries every lane over the gorge: z ∈ [REAL_Z0, REAL_Z1] */
export const REAL_Z0 = -6.4;
export const REAL_Z1 = 21.5;
/** the broken bridge runs parallel on the hazard side, centred on BROKEN_Z; its deck is missing for x ∈ [sx + GAP_X0, sx + GAP_X1] */
export const BROKEN_Z = -11;
export const BROKEN_W = 3.6;
export const GAP_X0 = 7.6;
export const GAP_X1 = 11.4;

// ── Rockfall Pass: rock walls on both sides; boulders land on the road ahead of the stopped Sekisho car ──
export const WALL_Z_FAR = -8.5;
export const WALL_Z_NEAR = 22.5;
