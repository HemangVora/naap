import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BarrierId } from '../../types';
import { RUNUP_X, endX, stationX } from '../layout';
import * as G from './geo';
import { M, emberMat, lavaMat, particleGeo, waterMat } from './mats';
import { bridgeSignTexture, chevronTexture, detourTexture, glowTex, priceBoardTexture, prizeTexture } from './signs';
import { fbm, noise2, rng, type Scatter } from './scatter';
import { rockMaterial, spireGeometry, strataWall, type Palette } from './rockkit';

// One plot = one mesa. Its heightfield follows the obstacle order: each station's segment is carved into that obstacle's
// biome (Signal Ridge cliff, Caldera lava bowl, River Canyon gorge, Rockfall Pass walls, Meadow hills). One draw call per plot.

export interface TrackLike {
  spec: { id: string; obstacles: { type: BarrierId; amountUsd?: number }[] };
  n: number;
  group: THREE.Group;
  origin: { x: number; z: number };
}

export interface StormFx {
  x: number; // world (the Morse beacon)
  z: number;
  y: number;
  beacon: THREE.Sprite;
  wash: THREE.Sprite;
}
export interface CalderaFx {
  x: number;
  z: number;
  embers: THREE.Points;
  shimmer: THREE.Mesh[];
  glow: THREE.Sprite;
  vaultGlow: THREE.Sprite;
}
export interface PlotDress {
  heightAt(lx: number, lz: number): number;
  typeAt(lx: number): BarrierId | 'start';
  storms: StormFx[];
  calderas: CalderaFx[];
  rivers: THREE.Mesh[];
  meshes: THREE.Object3D[];
  /** where a biome wants the obstacle's standard prop (track-local); null = keep the default spot */
  propSpot(i: number): { x: number; y: number; z: number; rotY: number } | null;
}

const BAND0 = -7.2;
const BAND1 = 21.8;
const Z0 = -26;
const Z1 = 26;
const ss = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

const C = {
  grass: new THREE.Color('#6f8b45'),
  grassHi: new THREE.Color('#8ea85c'),
  verge: new THREE.Color('#7a9150'),
  slate: new THREE.Color('#5f646c'),
  slateHi: new THREE.Color('#737880'),
  scree: new THREE.Color('#77716a'),
  basalt: new THREE.Color('#2b2522'),
  scorch: new THREE.Color('#4a1f12'),
  sand: new THREE.Color('#bf7d44'),
  sandWall: new THREE.Color('#9a5a31'),
  bed: new THREE.Color('#5d4a36'),
  path: new THREE.Color('#a8875e'),
  ochre: new THREE.Color('#8c7b62'),
  ochreHi: new THREE.Color('#a8977a'),
  valley: new THREE.Color('#6d7c4a'),
};

export function buildPlot(track: TrackLike, scatter: Scatter): PlotDress {
  const n = track.n;
  const obs = track.spec.obstacles;
  const sxs = obs.map((_, i) => stationX(i, n));
  const PX0 = RUNUP_X - 6;
  const PX1 = endX(n) + 12;
  const ox = track.origin.x;
  const oz = track.origin.z;
  const seg = (x: number) => {
    let k = -1;
    for (let i = 0; i < sxs.length; i++) if (x >= sxs[i] + (i === 0 ? -8 : -6)) k = i;
    return k;
  };
  const typeAt = (x: number): BarrierId | 'start' => {
    const k = seg(x);
    return k < 0 ? 'start' : obs[k].type;
  };

  /** raw height + colour for a local point */
  function sample(x: number, z: number, out?: THREE.Color): number {
    const k = seg(x);
    const type: BarrierId | 'start' = k < 0 ? 'start' : obs[k].type;
    const u = k < 0 ? 0 : x - sxs[k];
    const d = z < BAND0 ? BAND0 - z : z > BAND1 ? z - BAND1 : 0;
    const nz = fbm((x + ox) * 0.07, (z + oz) * 0.07);
    const nz2 = noise2((x + ox) * 0.31, (z + oz) * 0.31);
    let h = 0;
    let c = C.verge;
    let t = 0;
    switch (type) {
      case 'start':
      case 'legit':
        h = (nz * 5.5 + nz2 * 0.9) * ss(5, 16, d);
        t = h / 5;
        if (out) out.copy(C.grass).lerp(C.grassHi, Math.min(1, t)).lerp(C.verge, d < 3 ? 0.6 : 0);
        break;
      case 'grok-morse': {
        const inCliff = u >= G.CLIFF_X0 && u <= G.CLIFF_X1;
        if (z < G.CLIFF_Z && inCliff) {
          h = G.CLIFF_FLOOR_Y + nz * 2.4 + nz2 * 0.8 + ss(-19, -25, z) * 3;
          if (out) out.copy(C.scree).lerp(C.slate, nz2 * 0.5);
        } else {
          h = d > 0 ? (z > 0 ? 0.4 + nz * 2.5 : 1 + nz * 7 + nz2 * 1.6) * ss(0, 4, d) : 0;
          if (out) out.copy(C.slate).lerp(C.slateHi, Math.min(1, h / 8));
        }
        break;
      }
      case 'freysa': {
        const inBowl = u >= G.LAVA_X0 && u <= G.LAVA_X1 && z < G.LAVA_Z1;
        if (inBowl) {
          const dv = Math.hypot(u - G.VAULT.dx, z - G.VAULT.z);
          const rim = Math.max(ss(G.LAVA_X0 + 2.2, G.LAVA_X0, u), ss(G.LAVA_X1 - 2.2, G.LAVA_X1, u), ss(G.LAVA_Z0 + 2.2, G.LAVA_Z0, z));
          h = G.LAVA_Y - 1.4 + rim * (4.5 + nz * 3);
          if (dv < 5.2) h = Math.max(h, G.LAVA_Y + 0.9 + ss(5.2, 3.2, dv) * 1.4 + nz2 * 0.3);
          if (out) out.copy(C.scorch).lerp(C.basalt, Math.min(1, rim + (dv < 5.2 ? 0.7 : 0)));
        } else {
          h = d > 0 ? (z > 0 ? 0.3 + nz * 2 : 0.6 + nz * 4.5 + nz2) * ss(0, 4, d) : 0;
          if (out) out.copy(C.basalt).lerp(C.scorch, nz2 * 0.4);
        }
        break;
      }
      case 'x402-swap': {
        if (u >= G.RIVER_X0 && u <= G.RIVER_X1) {
          h = G.WATER_Y - 2.4 + nz2 * 0.6;
          if (out) out.copy(C.bed);
        } else if (z < BAND0 && u >= -3 && u < G.RIVER_X0 && z > -14.5) {
          h = 0; // the detour path to the broken bridge
          if (out) out.copy(C.path);
        } else {
          h = d > 0 ? (z > 0 ? 0.4 + nz * 2.5 : 1 + nz * 6 + nz2 * 1.2) * ss(0, 5, d) : 0;
          if (out) out.copy(C.sand).lerp(C.sandWall, nz2 * 0.35);
        }
        break;
      }
      case 'over-limit': {
        const inPass = u >= -9 && u <= 15;
        if (inPass && z < G.WALL_Z_FAR) {
          h = ss(G.WALL_Z_FAR - 1.4, G.WALL_Z_FAR - 3.2, z) * (10.5 + nz * 3 + nz2 * 1.2);
          if (out) out.copy(C.ochre).lerp(C.ochreHi, nz2);
        } else if (inPass && z > G.WALL_Z_NEAR) {
          h = ss(G.WALL_Z_NEAR + 1.2, G.WALL_Z_NEAR + 2.6, z) * (3.2 + nz * 1.5);
          if (out) out.copy(C.ochre).lerp(C.ochreHi, nz2);
        } else {
          h = d > 0 ? (0.5 + nz * 4) * ss(0, 4, d) : 0;
          if (out) out.copy(C.ochre).lerp(C.grass, 0.25);
        }
        break;
      }
    }
    // mesa edges fall to the lowland
    const ex = Math.max(ss(PX0, PX0 - 16, x), ss(PX1, PX1 + 16, x));
    if (ex > 0) {
      h = h + (G.VALLEY_Y + nz * 6 - h) * ex;
      if (out) out.lerp(C.slate, ex * 0.6);
    }
    if (z <= Z0 + 0.01 || z >= Z1 - 0.01) h = G.VALLEY_Y;
    // off-band rock faces read darker
    if (out && h < -1 && type !== 'freysa') out.multiplyScalar(0.82);
    return h;
  }

  // ── heightfield mesh ──
  const X0 = PX0 - 18;
  const X1 = PX1 + 18;
  const segX = Math.ceil(X1 - X0);
  const segZ = Z1 - Z0;
  const geo = new THREE.PlaneGeometry(segX, segZ, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  geo.translate(X0 + segX / 2, 0, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = sample(x, z, c);
    pos.setY(i, h - (h === 0 ? 0.002 : 0));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, M.terrain);
  ground.receiveShadow = true;
  ground.castShadow = false; // perf: the shadow pass skips the heightfields (flat shading carries the relief)
  ground.name = 'terrain';
  ground.userData.ground = true;
  track.group.add(ground);
  const meshes: THREE.Object3D[] = [ground];
  const add = <T extends THREE.Object3D>(o: T) => {
    track.group.add(o);
    meshes.push(o);
    return o;
  };

  const heightAt = (lx: number, lz: number) => sample(lx, lz);

  // ── scatter (world space): pines on the meadows, rock clusters (1 big + medium + scree) in the rock biomes ──
  const R = rng(Math.abs(Math.round(ox * 13 + oz * 7)) + 11);
  const kit = scatter.kit;
  const PAL: Partial<Record<BarrierId, Palette>> = { 'grok-morse': 'granite', freysa: 'basalt', 'x402-swap': 'sand', 'over-limit': 'ochre' };
  const groundW = (wx: number, wz: number) => sample(wx - ox, wz - oz);
  /** keep rocks off the lanes, out of the river / lava / wall bodies */
  const clear = (wx: number, wz: number) => {
    const x = wx - ox;
    const z = wz - oz;
    if (z > BAND0 - 1.1 && z < BAND1 + 1.1) return false;
    if (z < Z0 + 1.5 || z > Z1 - 1.5) return false;
    const k = seg(x);
    if (k >= 0) {
      const u = x - sxs[k];
      const ty = obs[k].type;
      if (ty === 'x402-swap' && u > G.RIVER_X0 - 0.6 && u < G.RIVER_X1 + 0.6) return false;
      if (ty === 'x402-swap' && z < BAND0 && z > -16 && u > -4 && u < G.RIVER_X1 + 2) return false; // detour + broken bridge
      if (ty === 'freysa' && u > G.LAVA_X0 - 0.5 && u < G.LAVA_X1 + 0.5 && z < G.LAVA_Z1 + 0.5) return false;
      if (ty === 'over-limit' && u > -10 && u < 16 && (z < G.WALL_Z_FAR - 0.9 || z > G.WALL_Z_NEAR + 0.6)) return false;
      if (ty === 'grok-morse' && u > G.CLIFF_X0 - 1 && u < G.CLIFF_X1 + 1 && z < G.CLIFF_Z + 0.5 && z > -21.5) return false;
    }
    return sample(x, z) > G.VALLEY_Y + 3;
  };
  for (let i = 0; i < 90; i++) {
    const x = PX0 + R() * (PX1 - PX0);
    const z = R() < 0.5 ? -25 + R() * 16 : 23 + R() * 2.5;
    const t = typeAt(x);
    const h = sample(x, z);
    if (t === 'legit' || t === 'start') {
      if (h < -0.6) continue;
      if (z > BAND0 - 5 && z < BAND1 + 1) continue;
      const s = 0.7 + R() * 0.7;
      scatter.pines.add(x + ox, h - 0.2, z + oz, s, s * (0.9 + R() * 0.4), s, 0, R() * 6, 0);
    } else if (i % 3 === 0) {
      kit.cluster(PAL[t] ?? 'granite', R, x + ox, z + oz, 0.9 + R() * 1.3, groundW, clear);
    }
  }

  const storms: StormFx[] = [];
  const calderas: CalderaFx[] = [];
  const rivers: THREE.Mesh[] = [];
  const spots: ({ x: number; y: number; z: number; rotY: number } | null)[] = [];

  const cliffParts: THREE.BufferGeometry[] = [];
  const mat4 = (rotY: number, x: number, z: number) => new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeRotationY(rotY));
  const H2 = Math.PI / 2;

  obs.forEach((ob, i) => {
    const sx = sxs[i];
    spots[i] = null;
    if (ob.type === 'grok-morse') {
      // guard rail along the cliff edge (one merged mesh)
      const parts: THREE.BufferGeometry[] = [];
      const x0 = sx + G.CLIFF_X0;
      const x1 = sx + G.CLIFF_X1;
      for (const y of [0.55, 0.85]) {
        const b = new THREE.BoxGeometry(x1 - x0, 0.22, 0.08);
        b.translate((x0 + x1) / 2, y, G.RAIL_Z);
        parts.push(b);
      }
      for (let x = x0; x <= x1 + 0.01; x += 2) {
        const p = new THREE.BoxGeometry(0.14, 1.0, 0.14);
        p.translate(x, 0.5, G.RAIL_Z - 0.1);
        parts.push(p);
      }
      const rail = new THREE.Mesh(mergeGeometries(parts)!, M.rail);
      rail.userData.solid = true;
      rail.castShadow = true;
      add(rail);
      // rock spire in the chasm carrying the Morse billboard + radio mast
      const spX = sx + 2;
      const spZ = -19.2;
      const spire = new THREE.Mesh(spireGeometry(spX, spZ, G.CLIFF_FLOOR_Y - 1, 1.5, 5.4, 3.5, 'granite', 300 + i * 17 + Math.round(oz)), rockMaterial());
      spire.castShadow = spire.receiveShadow = true;
      spire.userData.solid = true;
      add(spire);
      spots[i] = { x: spX, y: 1.5, z: spZ + 0.6, rotY: 0 };
      // lattice radio mast with a Morse beacon
      const mastParts: THREE.BufferGeometry[] = [];
      const H = 17;
      for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const leg = new THREE.CylinderGeometry(0.06, 0.1, H, 4);
        leg.translate(dx * (1 - 0.5), H / 2, dz * 1);
        mastParts.push(leg);
      }
      for (let y = 1.2; y < H; y += 1.6) {
        const r1 = new THREE.BoxGeometry(0.06, 0.06, 1.1);
        r1.rotateX(0.9);
        r1.translate(0.25, y + 0.5, 0);
        const r2 = new THREE.BoxGeometry(0.06, 0.06, 1.1);
        r2.rotateX(-0.9);
        r2.translate(-0.25, y + 0.5, 0);
        mastParts.push(r1, r2);
      }
      const mast = new THREE.Mesh(mergeGeometries(mastParts)!, M.vermilion);
      mast.position.set(spX + 3.3, 1.5, spZ - 1.2);
      mast.castShadow = true;
      mast.userData.solid = true;
      add(mast);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), M.morse);
      beacon.position.set(spX + 3.3, 1.5 + H + 0.4, spZ - 1.2);
      add(beacon);
      const bGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xff3a1a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      bGlow.scale.set(3.6, 3.6, 1);
      bGlow.material.opacity = 0.75;
      bGlow.position.copy(beacon.position);
      bGlow.userData.morse = true;
      add(bGlow);
      // Signal Ridge: no weather — a clear, sharp cliff pass; a red wash from the beacon on the rock below it
      const wash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xff2a10, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      wash.scale.set(16, 16, 1);
      wash.position.set(spX + 3.3, 1.5 + H * 0.6, spZ - 1.2);
      add(wash);
      // the drop: granite strata on the cliff face and both chasm sides, scree + boulders on the floor
      const sd = 40 + i * 7 + Math.round(Math.abs(oz));
      cliffParts.push(
        strataWall({ x0: -(sx + G.CLIFF_X1 + 0.6), x1: -(sx + G.CLIFF_X0 - 0.6), yBase: G.CLIFF_FLOOR_Y - 1.5, yTop: 0, capY: -0.06, depth: 3.5, seed: sd, pal: 'granite', matrix: mat4(Math.PI, 0, G.CLIFF_Z - 0.35) }),
        strataWall({ x0: -G.CLIFF_Z + 0.4, x1: 25.5, yBase: G.CLIFF_FLOOR_Y - 1.5, yTop: 9, capAt: (lx) => sample(sx + G.CLIFF_X0 - 0.6, -lx) - 0.05, crest: 1, depth: 3.5, seed: sd + 1, pal: 'granite', matrix: mat4(H2, sx + G.CLIFF_X0 - 0.2, 0) }),
        strataWall({ x0: -25.5, x1: G.CLIFF_Z - 0.4, yBase: G.CLIFF_FLOOR_Y - 1.5, yTop: 9, capAt: (lx) => sample(sx + G.CLIFF_X1 + 0.6, lx) - 0.05, crest: 1, depth: 3.5, seed: sd + 2, pal: 'granite', matrix: mat4(-H2, sx + G.CLIFF_X1 + 0.2, 0) }),
      );
      for (let k = 0; k < 9; k++) {
        const cx = sx + G.CLIFF_X0 + 1.5 + ((k + R()) / 9) * (G.CLIFF_X1 - G.CLIFF_X0 - 3);
        const cz = k % 2 ? -9.8 - R() * 2.5 : -21 - R() * 3;
        if (Math.hypot(cx - spX, cz - spZ) < 6.5) continue;
        if (Math.hypot(cx - (sx + G.CLIFF_REST.dx), cz - G.CLIFF_REST.z) < 3.5) continue;
        kit.cluster('granite', R, cx + ox, cz + oz, 1.2 + R() * 1.4, groundW);
      }
      for (let k = 0; k < 40; k++) {
        const x = sx + G.CLIFF_X0 + R() * (G.CLIFF_X1 - G.CLIFF_X0);
        const z = G.CLIFF_Z - 0.8 - Math.pow(R(), 1.8) * 5;
        kit.scree('granite', k, x + ox, sample(x, z), z + oz, 0.2 + R() * 0.45, R() * 6.28, 0.85 + R() * 0.25);
      }
      storms.push({ x: spX + 3.3 + ox, y: 1.5 + H, z: spZ - 1.2 + oz, beacon: bGlow, wash });
    } else if (ob.type === 'freysa') {
      const w = G.LAVA_X1 - G.LAVA_X0;
      const d = G.LAVA_Z1 - G.LAVA_Z0 + 0.8;
      const lava = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 1, 1), lavaMat);
      lava.rotation.x = -Math.PI / 2;
      lava.position.set(sx + (G.LAVA_X0 + G.LAVA_X1) / 2, G.LAVA_Y, (G.LAVA_Z0 + G.LAVA_Z1 + 0.8) / 2);
      lava.userData.noCollide = true; // visitors sink
      add(lava);
      // vault on the island
      const vx = sx + G.VAULT.dx - 1;
      const vz = G.VAULT.z + 1;
      const iy = G.LAVA_Y + 2.3;
      const vault = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 2.6), M.gold);
      vault.position.set(vx, iy + 1.3, vz);
      vault.castShadow = true;
      vault.userData.solid = true;
      add(vault);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshBasicMaterial({ map: prizeTexture(), toneMapped: false }));
      face.position.set(vx, iy + 1.4, vz + 1.31);
      add(face);
      const face2 = face.clone();
      face2.position.set(vx - 1.71, iy + 1.4, vz);
      face2.rotation.y = -Math.PI / 2;
      add(face2);
      const vaultGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffc040, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
      vaultGlow.scale.set(12, 12, 1);
      vaultGlow.position.set(vx, iy + 1.6, vz);
      add(vaultGlow);
      spots[i] = { x: sx + G.VAULT.dx + 2.2, y: iy - 0.4, z: G.VAULT.z - 2.2, rotY: 0.2 };
      // the "receive the prize" ramp
      const rs = G.RAMP_START;
      const re = G.RAMP_END;
      const len = Math.hypot(re.dx - rs.dx, re.z - rs.z);
      const yaw = Math.atan2(-(re.z - rs.z), re.dx - rs.dx);
      const pitch = Math.atan2(G.RAMP_TOP_Y, len);
      const rampGeo = new THREE.BoxGeometry(len / Math.cos(pitch), 0.25, 3);
      rampGeo.translate(len / Math.cos(pitch) / 2, -0.12, 0);
      const chev = chevronTexture();
      const ramp = new THREE.Mesh(rampGeo, [M.dark, M.dark, new THREE.MeshStandardMaterial({ map: chev, roughness: 0.6 }), M.dark, M.yellow, M.yellow]);
      chev.repeat.set(4, 1);
      ramp.position.set(sx + rs.dx, 0.02, rs.z);
      ramp.rotation.set(0, yaw, pitch);
      ramp.castShadow = true;
      ramp.userData.ground = true;
      add(ramp);
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.6, G.RAMP_TOP_Y - G.LAVA_Y, 0.6), M.dark);
      pylon.position.set(sx + re.dx - 0.8, (G.RAMP_TOP_Y + G.LAVA_Y) / 2 - 0.3, re.z + 0.6);
      add(pylon);
      const embers = new THREE.Points(particleGeo(260, w - 2, d - 2, i * 7 + oz), emberMat);
      embers.userData.noCollide = true;
      embers.position.set(sx + (G.LAVA_X0 + G.LAVA_X1) / 2, G.LAVA_Y, (G.LAVA_Z0 + G.LAVA_Z1) / 2);
      add(embers);
      const shimmer: THREE.Mesh[] = [];
      for (let k = 0; k < 3; k++) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.8, 7, 1, 1), M.shimmer);
        p.position.set(sx + (G.LAVA_X0 + G.LAVA_X1) / 2, G.LAVA_Y + 3.5, G.LAVA_Z1 - 3 - k * 4.5);
        p.userData.noCollide = true;
        add(p);
        shimmer.push(p);
      }
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xff5010, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.set(w * 1.6, 14, 1);
      glow.position.set(sx + (G.LAVA_X0 + G.LAVA_X1) / 2, G.LAVA_Y + 3, (G.LAVA_Z0 + G.LAVA_Z1) / 2);
      add(glow);
      calderas.push({ x: glow.position.x + ox, z: glow.position.z + oz, embers, shimmer, glow, vaultGlow });
      // jagged basalt rim: leaning shards along the three far edges, hot at the lava line
      const rimPts: [number, number, number][] = [];
      for (let z = G.LAVA_Z0 + 1; z < G.LAVA_Z1 - 1.5; z += 1.6 + R() * 1.2) {
        rimPts.push([G.LAVA_X0 + 0.6 + R() * 1.2, z, 1]);
        rimPts.push([G.LAVA_X1 - 0.6 - R() * 1.2, z, -1]);
      }
      for (let u = G.LAVA_X0 + 1; u < G.LAVA_X1 - 1; u += 1.5 + R() * 1.2) rimPts.push([u, G.LAVA_Z0 + 0.6 + R() * 1.2, 0]);
      for (const [u, z, side] of rimPts) {
        const x = sx + u;
        const s = 0.9 + R() * 1.1;
        const lean = side === 0 ? 0 : side * (0.15 + R() * 0.2);
        kit.shard('basalt', Math.floor(R() * 3), x + ox, Math.max(G.LAVA_Y - 0.6, sample(x, z) - 0.3), z + oz, s, R() * 6.28, lean, 0.85 + R() * 0.3);
      }
      // near shore (road side): low glowing blocks, clear of the ramp
      for (let u = G.LAVA_X0 + 0.5; u < G.LAVA_X1; u += 1.4 + R()) {
        if (u > G.RAMP_START.dx - 1.5 && u < G.RAMP_END.dx + 2) continue;
        const x = sx + u;
        const z = G.LAVA_Z1 - 0.9 - R() * 0.8;
        kit.boulder('basalt', Math.floor(R() * 6), x + ox, G.LAVA_Y - 0.1, z + oz, 0.6 + R() * 0.7, R() * 6.28, { sy: 0.8, tint: 0.9 + R() * 0.2 });
      }
      // the vault island: a ring of basalt, and a few crust rocks floating in the lava
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2 + R() * 0.4;
        const x = sx + G.VAULT.dx + Math.cos(a) * (4.4 + R() * 0.8);
        const z = G.VAULT.z + Math.sin(a) * (4.4 + R() * 0.8);
        if (Math.hypot(x - (sx + G.RAMP_END.dx), z - G.RAMP_END.z) < 3.5) continue;
        kit.boulder('basalt', k, x + ox, G.LAVA_Y - 0.1, z + oz, 0.7 + R() * 0.8, R() * 6.28, { tint: 0.9 + R() * 0.2 });
      }
      for (let k = 0; k < 8; k++) {
        const x = sx + G.LAVA_X0 + 2 + R() * (G.LAVA_X1 - G.LAVA_X0 - 4);
        const z = G.LAVA_Z0 + 2 + R() * (G.LAVA_Z1 - G.LAVA_Z0 - 4);
        if (Math.hypot(x - (sx + G.VAULT.dx), z - G.VAULT.z) < 6) continue;
        kit.scree('basalt', k, x + ox, G.LAVA_Y - 0.05, z + oz, 0.5 + R() * 0.6, R() * 6.28);
      }
    } else if (ob.type === 'x402-swap') {
      const water = new THREE.Mesh(new THREE.PlaneGeometry(G.RIVER_X1 - G.RIVER_X0 + 1.2, Z1 - Z0 + 4, 8, 30), waterMat);
      water.rotation.x = -Math.PI / 2;
      water.position.set(sx + (G.RIVER_X0 + G.RIVER_X1) / 2, G.WATER_Y, 0);
      water.userData.noCollide = true;
      add(water);
      rivers.push(water);
      // the real bridge: deck under every lane + steel truss + ENS sign
      const bx0 = sx + G.RIVER_X0 - 1;
      const bx1 = sx + G.RIVER_X1 + 1;
      const bl = bx1 - bx0;
      const bcx = (bx0 + bx1) / 2;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(bl, 1.2, G.REAL_Z1 - G.REAL_Z0), M.concrete);
      deck.position.set(bcx, -0.62, (G.REAL_Z0 + G.REAL_Z1) / 2);
      deck.receiveShadow = deck.castShadow = true;
      deck.userData.ground = true;
      add(deck);
      const truss: THREE.BufferGeometry[] = [];
      for (const z of [G.REAL_Z0 + 0.1, G.REAL_Z1 - 0.1]) {
        const top = new THREE.BoxGeometry(bl - 2, 0.35, 0.35);
        top.translate(bcx, 3.2, z);
        truss.push(top);
        for (let k = 0; k <= 4; k++) {
          const px = bx0 + 1 + ((bl - 2) * k) / 4;
          const post = new THREE.BoxGeometry(0.3, 3.2, 0.3);
          post.translate(px, 1.6, z);
          truss.push(post);
          if (k < 4) {
            const diag = new THREE.BoxGeometry(Math.hypot((bl - 2) / 4, 3.2), 0.22, 0.22);
            diag.rotateZ(Math.atan2(3.2, (bl - 2) / 4) * (k % 2 ? 1 : -1));
            diag.translate(px + (bl - 2) / 8, 1.6, z);
            truss.push(diag);
          }
        }
      }
      for (let k = 0; k < 3; k++) {
        const pier = new THREE.BoxGeometry(1.4, -G.WATER_Y + 2.5, 1.4);
        pier.translate(bcx, (G.WATER_Y - 2.5) / 2 - 1.2, G.REAL_Z0 + 2 + k * 9.5);
        truss.push(pier);
      }
      const trussMesh = new THREE.Mesh(mergeGeometries(truss)!, M.steel);
      trussMesh.castShadow = true;
      trussMesh.userData.solid = true;
      add(trussMesh);
      const signMat = new THREE.MeshBasicMaterial({ map: bridgeSignTexture(), toneMapped: false, side: THREE.DoubleSide });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 2), signMat);
      sign.position.set(bx0 + 0.2, 5.6, -1.8);
      sign.rotation.y = -Math.PI / 2 + 0.5;
      add(sign);
      for (const z of [-4.8, 1.2]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 5.6, 0.25), M.steel);
        p.position.set(bx0 + 0.4, 2.8, z);
        add(p);
      }
      // the broken bridge on the hazard side: rotten planks, a missing span, a slab hanging into the gorge
      const bz = G.BROKEN_Z;
      const bw = G.BROKEN_W;
      const bb: THREE.BufferGeometry[] = [];
      const deckA = new THREE.BoxGeometry(G.GAP_X0 - G.RIVER_X0 + 1.5, 0.35, bw);
      deckA.translate(sx + (G.RIVER_X0 - 1.5 + G.GAP_X0) / 2, -0.18, bz);
      const deckB = new THREE.BoxGeometry(G.RIVER_X1 + 1 - G.GAP_X1, 0.35, bw);
      deckB.translate(sx + (G.GAP_X1 + G.RIVER_X1 + 1) / 2, -0.18, bz);
      bb.push(deckA, deckB);
      const hang = new THREE.BoxGeometry(2.4, 0.3, bw * 0.8);
      hang.translate(1.2, 0, 0);
      hang.rotateZ(-1.05);
      hang.translate(sx + G.GAP_X0, -0.2, bz + 0.3);
      bb.push(hang);
      for (const x of [G.RIVER_X0 + 0.8, G.RIVER_X1 - 0.8]) {
        const pier = new THREE.BoxGeometry(0.6, -G.WATER_Y + 1, 0.6);
        pier.translate(sx + x, (G.WATER_Y - 1) / 2, bz);
        bb.push(pier);
      }
      for (const z of [bz - bw / 2, bz + bw / 2]) {
        for (const [a, b] of [
          [G.RIVER_X0 - 1.5, G.GAP_X0 - 0.3],
          [G.GAP_X1 + 0.4, G.RIVER_X1 + 1],
        ]) {
          const r = new THREE.BoxGeometry(b - a, 0.12, 0.12);
          r.translate(sx + (a + b) / 2, 0.9, z);
          bb.push(r);
        }
      }
      const broken = new THREE.Mesh(mergeGeometries(bb)!, M.rotten);
      broken.castShadow = true;
      broken.userData.ground = true;
      add(broken);
      // the swapped detour sign pointing at it
      const det = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshBasicMaterial({ map: detourTexture(), transparent: true, alphaTest: 0.4, toneMapped: false, side: THREE.DoubleSide }));
      det.position.set(sx - 6, 3.6, -9.2);
      det.rotation.y = 0.5;
      add(det);
      const dp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.2, 0.2), M.steel);
      dp.position.set(sx - 6, 1.1, -9.25);
      add(dp);
      spots[i] = { x: sx + 1.6, y: 0, z: -14.6, rotY: 0.15 };
      const sd = 70 + i * 7 + Math.round(Math.abs(oz));
      cliffParts.push(
        strataWall({ x0: Z0 + 0.3, x1: Z1 - 0.3, yBase: G.WATER_Y - 3, yTop: 8, capAt: (lx) => sample(sx + G.RIVER_X0 - 0.6, -lx) - 0.05, crest: 0.6, depth: 3, layer: [1.5, 1.8], seed: sd, pal: 'sand', matrix: mat4(H2, sx + G.RIVER_X0 + 0.25, 0) }),
        strataWall({ x0: Z0 + 0.3, x1: Z1 - 0.3, yBase: G.WATER_Y - 3, yTop: 8, capAt: (lx) => sample(sx + G.RIVER_X1 + 0.6, lx) - 0.05, crest: 0.6, depth: 3, layer: [1.5, 1.8], seed: sd + 1, pal: 'sand', matrix: mat4(-H2, sx + G.RIVER_X1 - 0.25, 0) }),
      );
      // boulders in the river bed along both banks (the water runs between them)
      for (let k = 0; k < 10; k++) {
        const left = k % 2 === 0;
        const x = sx + (left ? G.RIVER_X0 + 0.9 + R() * 0.8 : G.RIVER_X1 - 0.9 - R() * 0.8);
        const z = Z0 + 2 + R() * (Z1 - Z0 - 4);
        kit.boulder('sand', k, x + ox, G.WATER_Y - 1.2, z + oz, 0.7 + R() * 0.8, R() * 6.28, { tint: 0.8 + R() * 0.15 });
      }
    } else if (ob.type === 'over-limit') {
      // the pass: a tall stacked-strata wall on the far side that leans out over the road, a low one on the near side
      const sd = 90 + i * 7 + Math.round(Math.abs(oz));
      const FACE = G.WALL_Z_FAR - 1.25;
      const TOP = 12.5;
      cliffParts.push(
        strataWall({ x0: sx - 9.5, x1: sx + 15.5, yBase: -0.6, yTop: TOP, depth: 6.5, overhang: 2.2, crest: 2.4, taper: 5, seed: sd, pal: 'ochre', matrix: mat4(0, 0, FACE) }),
        strataWall({ x0: -(sx + 15.5), x1: -(sx - 9.5), yBase: -0.6, yTop: 4.6, depth: 3.5, overhang: 0.4, crest: 1.2, taper: 3, seed: sd + 1, pal: 'ochre', matrix: mat4(Math.PI, 0, G.WALL_Z_NEAR + 1.1) }),
      );
      // loose boulders perched on the lip — the ones that come down when Sekisho refuses
      for (let k = 0; k < 8; k++) {
        const bx = sx - 7 + k * 3 + R() * 1.4;
        const s = 1.0 + R() * 0.9;
        kit.boulder('ochre', k, bx + ox, TOP + 0.4 + R() * 0.8, FACE - 0.6 + R() * 0.9 + oz, s, R() * 6.28, { tint: 0.95 + R() * 0.1, tilt: (R() - 0.5) * 0.3 });
      }
      for (let k = 0; k < 5; k++) {
        const bx = sx - 6 + k * 4.5 + R() * 1.5;
        kit.boulder('ochre', k + 2, bx + ox, 4.4, G.WALL_Z_NEAR + 1.6 + R() * 0.8 + oz, 0.8 + R() * 0.7, R() * 6.28);
      }
      // scree fans at the foot of the far wall (between the wall and the road edge)
      for (let k = 0; k < 70; k++) {
        const x = sx - 9 + R() * 24;
        const z = FACE + 0.2 + Math.pow(R(), 1.6) * (BAND0 - 0.5 - FACE - 0.2);
        kit.scree('ochre', k, x + ox, 0, z + oz, 0.18 + R() * 0.4, R() * 6.28, 0.85 + R() * 0.25);
      }
      for (let k = 0; k < 4; k++) {
        const x = sx - 7 + k * 6 + R() * 2;
        kit.boulder('ochre', k, x + ox, 0, FACE + 0.5 + oz, 0.6 + R() * 0.5, R() * 6.28, { sy: 0.8 });
      }
      const amt = obs[i].amountUsd ?? 40;
      const board = new THREE.Mesh(new THREE.PlaneGeometry(9, 4.5), new THREE.MeshBasicMaterial({ map: priceBoardTexture(amt), toneMapped: false }));
      board.position.set(sx + 3, 6.2, G.WALL_Z_FAR + 0.8);
      for (const dx of [-3.6, 3.6]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.2, 0.35), M.dark);
        post.position.set(sx + 3 + dx, 2.0, G.WALL_Z_FAR + 0.3);
        add(post);
      }
      add(board);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(9.5, 5, 0.4), M.dark);
      frame.position.set(sx + 3, 6.2, G.WALL_Z_FAR + 0.55);
      frame.userData.solid = true;
      add(frame);
      spots[i] = { x: sx - 3.5, y: 0, z: -7.9, rotY: 0 };
    }
  });

  if (cliffParts.length) {
    const cliffs = new THREE.Mesh(mergeGeometries(cliffParts)!, rockMaterial());
    cliffs.name = 'cliffs';
    cliffs.castShadow = true;
    cliffs.receiveShadow = true;
    cliffs.userData.solid = true;
    add(cliffs);
  }

  return { heightAt, typeAt, storms, calderas, rivers, meshes, propSpot: (i) => spots[i] ?? null };
}
