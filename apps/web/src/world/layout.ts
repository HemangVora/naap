// World layout: every track is a straight road on its own plot; plots fill a grid in a deterministic spiral from the centre.
// Track-local frame: the road runs along +x, the Sekisho lane of slot 0 sits on z = 0, its bare lane on z = −LANE_DZ.
// Extra concurrent cars on one track get extra lane pairs toward +z (slot k at z = +SLOT_DZ·k). Props stand on the far (−z) verge.

export const LANE_DZ = 3.7;
export const SLOT_DZ = 8.2;
export const MAX_SLOTS = 3;
export const START_X = -18;
export const RUNUP_X = -46; // the road starts here: painted track name, then the start line
export const PROP_Z = -11.5;

export const CELL_X = 210;
export const CELL_Z = 48;

export const spacing = (n: number) => (n <= 5 ? 22 : n <= 6 ? 20 : 17);
export const stationX = (i: number, n: number) => i * spacing(n);
export const endX = (n: number) => stationX(Math.max(0, n - 1), n) + 20;
export const slotZ = (slot: number) => slot * SLOT_DZ;
export const laneZ = (slot: number, variant: 'bare' | 'airbag') => slotZ(slot) - (variant === 'bare' ? LANE_DZ : 0);

/** Road midpoint for a track of n obstacles (so the road is centred on its plot). */
export const roadMidX = (n: number) => (RUNUP_X + endX(n) + 6) / 2;

/**
 * Grid cells ordered by distance from the centre in metres (Chebyshev, so rings stay roughly square even though plots are
 * long and thin), ties broken by angle. Deterministic: plot k is always the same cell, new tracks land on the outside.
 */
const ORDER: [number, number][] = (() => {
  const cells: { c: number; r: number; d: number; a: number }[] = [];
  for (let c = -4; c <= 4; c++)
    for (let r = -12; r <= 12; r++) {
      const x = c * CELL_X;
      const z = r * CELL_Z;
      cells.push({ c, r, d: Math.max(Math.abs(x), Math.abs(z) * 1.05), a: (Math.atan2(-z, x) + Math.PI * 2.5) % (Math.PI * 2) });
    }
  cells.sort((p, q) => p.d - q.d || p.a - q.a);
  return cells.map((x) => [x.c, x.r]);
})();

/** World-space origin of plot k (the track group's position). */
export function plotOrigin(k: number, n: number): { x: number; z: number; col: number; row: number } {
  const [col, row] = ORDER[Math.min(k, ORDER.length - 1)];
  return { x: col * CELL_X - roadMidX(n), z: row * CELL_Z, col, row };
}
