import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BarrierId } from '../../types';
import { RUNUP_X, endX, stationX } from '../layout';
import * as G from './geo';
import { M, emberMat, lavaMat, particleGeo, waterMat } from './mats';
import { bridgeSignTexture, chevronTexture, detourTexture, glowTex, priceBoardTexture, prizeTexture } from './signs';
import { fbm, noise2, rng, type Scatter } from './scatter';

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
          h = ss(G.WALL_Z_FAR, G.WALL_Z_FAR - 1.4, z) * (12 + nz * 5 + nz2 * 1.5);
          if (out) out.copy(C.ochre).lerp(C.ochreHi, nz2);
        } else if (inPass && z > G.WALL_Z_NEAR) {
          h = ss(G.WALL_Z_NEAR, G.WALL_Z_NEAR + 1.2, z) * (3.5 + nz * 2);
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

  // ── scatter (world space) ──
  const R = rng(Math.abs(Math.round(ox * 13 + oz * 7)) + 11);
  for (let i = 0; i < 90; i++) {
    const x = PX0 + R() * (PX1 - PX0);
    const z = R() < 0.5 ? -25 + R() * 16 : 23 + R() * 2.5;
    const t = typeAt(x);
    const h = sample(x, z);
    if (h < -0.6 && t !== 'x402-swap') continue;
    if (t === 'legit' || t === 'start') {
      if (z > BAND0 - 5 && z < BAND1 + 1) continue;
      const s = 0.7 + R() * 0.7;
      scatter.pines.add(x + ox, h - 0.2, z + oz, s, s * (0.9 + R() * 0.4), s, 0, R() * 6, 0);
    } else if (t !== 'x402-swap' || (z < -15 || z > 23)) {
      const s = 0.4 + R() * 1.3;
      const colr = t === 'grok-morse' ? '#6b6f76' : t === 'freysa' ? '#2d2724' : t === 'x402-swap' ? '#a86a3a' : '#857560';
      if (h < -0.6) continue;
      scatter.rocks.add(x + ox, h + s * 0.2, z + oz, s * 1.2, s * 0.8, s, R() * 3, R() * 3, R() * 3, colr);
    }
  }

  const storms: StormFx[] = [];
  const calderas: CalderaFx[] = [];
  const rivers: THREE.Mesh[] = [];
  const spots: ({ x: number; y: number; z: number; rotY: number } | null)[] = [];

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
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 5.2, 18, 7, 3), M.rock);
      spire.material = new THREE.MeshStandardMaterial({ color: 0x5a5f66, flatShading: true, roughness: 0.95 });
      spire.position.set(spX, G.CLIFF_FLOOR_Y + 9 - 0.5 + 0.5, spZ);
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
      for (let k = 0; k < 9; k++) {
        const a = R() * Math.PI * 2;
        const s = 0.8 + R() * 1.8;
        scatter.rocks.add(sx + 9 + ox + Math.cos(a) * (3 + R() * 6), G.CLIFF_FLOOR_Y + 1 + s * 0.3, -16 + oz + Math.sin(a) * 3, s * 1.3, s, s, R() * 3, R() * 3, R() * 3, '#5b5f66');
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
      for (let k = 0; k < 10; k++) {
        const a = R() * Math.PI * 2;
        const s = 0.8 + R() * 1.6;
        scatter.rocks.add(sx + G.VAULT.dx + ox + Math.cos(a) * (8 + R() * 6), G.LAVA_Y + 0.2, G.VAULT.z + oz + Math.sin(a) * 4, s, s * 0.6, s, R(), R() * 6, R(), '#231d1a');
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
    } else if (ob.type === 'over-limit') {
      // overhanging boulders on both wall tops
      for (let k = 0; k < 7; k++) {
        const bx = sx - 6 + k * 3.2 + R() * 1.5;
        const s = 1.4 + R() * 1.4;
        scatter.boulders.add(bx + ox, sample(bx, -10.2) + s * 0.4, -9.4 + oz, s * 1.2, s, s, R() * 3, R() * 3, R() * 3, '#7d6d58');
      }
      for (let k = 0; k < 5; k++) {
        const bx = sx - 6 + k * 4.5 + R() * 1.5;
        const s = 1.2 + R() * 1.2;
        scatter.boulders.add(bx + ox, sample(bx, 23.6) + s * 0.4, 23.4 + oz, s * 1.2, s, s, R() * 3, R() * 3, R() * 3, '#857560');
      }
      const amt = obs[i].amountUsd ?? 40;
      const board = new THREE.Mesh(new THREE.PlaneGeometry(9, 4.5), new THREE.MeshBasicMaterial({ map: priceBoardTexture(amt), toneMapped: false }));
      board.position.set(sx + 3, 6.2, G.WALL_Z_FAR - 0.25);
      add(board);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(9.5, 5, 0.4), M.dark);
      frame.position.set(sx + 3, 6.2, G.WALL_Z_FAR - 0.5);
      frame.userData.solid = true;
      add(frame);
      spots[i] = { x: sx - 3.5, y: 0, z: -7.9, rotY: 0 };
    }
  });

  return { heightAt, typeAt, storms, calderas, rivers, meshes, propSpot: (i) => spots[i] ?? null };
}
