import * as THREE from 'three';
import { billboardTexture, crackTexture, roundelTexture, sekiBadgeTexture, tapeTexture } from './textures';

// Car dimensions (metres). Nose at +x.
export const CAR_LEN = 4.2;
export const NOSE_X = CAR_LEN / 2;
export const CRUSH_MAX = 0.72; // how far the nose folds back at crush = 1

const LEN_SEGS = 32; // ≥ 24 length segments so the crush is real vertex deformation

const G = {
  body: new THREE.BoxGeometry(CAR_LEN, 0.65, 1.8, LEN_SEGS, 3, 8),
  cabin: new THREE.BoxGeometry(2.2, 0.55, 1.66, 16, 2, 6),
  bonnet: new THREE.PlaneGeometry(1.4, 1.7, 14, 6),
  roof: new THREE.BoxGeometry(1.5, 0.05, 1.5),
  wheel: new THREE.CylinderGeometry(0.34, 0.34, 0.26, 16),
  hub: new THREE.CylinderGeometry(0.2, 0.2, 0.28, 10),
  lamp: new THREE.BoxGeometry(0.08, 0.14, 0.34),
  decal: new THREE.PlaneGeometry(0.5, 0.5),
  tape: new THREE.PlaneGeometry(3.4, 0.12),
  badge: new THREE.PlaneGeometry(0.62, 0.62),
  billboard: new THREE.PlaneGeometry(3.2, 1),
  airbag: new THREE.SphereGeometry(0.32, 14, 10),
  head: new THREE.SphereGeometry(0.12, 12, 10),
  torso: new THREE.BoxGeometry(0.3, 0.34, 0.34),
};
const M = {
  tyre: new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.95 }),
  hub: new THREE.MeshStandardMaterial({ color: 0xc9c9c4, roughness: 0.35, metalness: 0.7 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x8fb8d8, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.42, depthWrite: false }),
  crack: null as THREE.MeshBasicMaterial | null,
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c2, emissiveIntensity: 0.8 }),
  tail: new THREE.MeshStandardMaterial({ color: 0xc8261c, roughness: 0.4 }),
  brake: new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 3 }),
  airbag: new THREE.MeshStandardMaterial({ color: 0xf6f4ee, roughness: 1 }),
  dummyHead: new THREE.MeshStandardMaterial({ color: 0xe3c48f, roughness: 0.7 }),
  dummyBody: new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.8 }),
};
let roundelMat: THREE.MeshBasicMaterial | null = null;
let badgeMat: THREE.MeshBasicMaterial | null = null;
let tapeMat: THREE.MeshBasicMaterial | null = null;

const bodyMatCache = new Map<string, THREE.MeshStandardMaterial>();
function bodyMaterial(color: string) {
  let m = bodyMatCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.32, metalness: 0.15 });
    bodyMatCache.set(color, m);
  }
  return m;
}

/** Everything the crash/AEB sims drive. Pure function of time in the sims; static otherwise. */
export interface CarPose {
  x: number;
  y: number;
  /** nose-down positive (rad) */
  pitch: number;
  /** 0..1 front crush */
  crush: number;
  /** 0..1 airbag inflation */
  airbag: number;
  /** dummy forward lurch (rad) */
  dummy: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Offset (MPDB-style) crush weight across the car width: far side (−z, barrier side) crushes fully. */
export const sideWeight = (oz: number) => 0.45 + 0.55 * clamp01((0.25 - oz) / 0.9);

export class CarMesh {
  group = new THREE.Group();
  chassis = new THREE.Group();
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  cabin: THREE.Mesh;
  bonnet: THREE.Mesh;
  windscreen: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  wheels: THREE.Mesh[] = [];
  private lamps: THREE.Mesh[] = [];
  private tail: THREE.Mesh[] = [];
  private airbags: THREE.Mesh[] = [];
  private dummy = new THREE.Group();
  private billboard: THREE.Mesh;
  private billboardTex: THREE.CanvasTexture;
  private orig: Float32Array;
  private origCabin: Float32Array;
  private origBonnet: Float32Array;
  private seed: Float32Array;
  private seedBonnet: Float32Array;
  private wheelX: number[] = [];
  /** persisted crush after the last crash (cars stay crumpled) */
  crush = 0;
  airbagRest = 0;
  private appliedCrush = -1;
  private wobbleT = Math.random() * 10;
  private idle = false;
  private brakeUntil = 0;

  constructor(public name: string, sub: string, public color: string, public airbag: boolean) {
    const bodyGeo = G.body.clone();
    const cabinGeo = G.cabin.clone();
    const bonnetGeo = G.bonnet.clone();
    this.shapeBody(bodyGeo);
    this.shapeCabin(cabinGeo);
    this.orig = (bodyGeo.attributes.position.array as Float32Array).slice();
    this.origCabin = (cabinGeo.attributes.position.array as Float32Array).slice();
    this.origBonnet = (bonnetGeo.attributes.position.array as Float32Array).slice();
    this.seed = new Float32Array(this.orig.length).map(() => Math.random() - 0.5);
    this.seedBonnet = new Float32Array(this.origBonnet.length).map(() => Math.random() - 0.5);

    const mat = bodyMaterial(color);
    this.body = new THREE.Mesh(bodyGeo, mat);
    this.body.position.y = 0.675;
    this.body.castShadow = true;
    this.cabin = new THREE.Mesh(cabinGeo, M.glass);
    this.cabin.position.set(-0.5, 1.275, 0);
    this.cabin.renderOrder = 2;
    const roof = new THREE.Mesh(G.roof, mat);
    roof.position.set(-0.55, 1.56, 0);
    roof.castShadow = true;
    this.bonnet = new THREE.Mesh(bonnetGeo, mat);
    this.bonnet.rotation.x = -Math.PI / 2;
    this.bonnet.position.set(1.3, 1.01, 0);
    this.bonnet.castShadow = true;
    this.chassis.add(this.body, this.cabin, roof, this.bonnet);

    const ws = new THREE.BufferGeometry();
    ws.setAttribute('position', new THREE.Float32BufferAttribute([0.64, 1.0, 0.8, 0.64, 1.0, -0.8, 0.02, 1.56, -0.74, 0.02, 1.56, 0.74], 3));
    ws.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    ws.setIndex([0, 1, 2, 0, 2, 3]);
    ws.computeVertexNormals();
    M.crack ??= new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false });
    this.windscreen = new THREE.Mesh(ws, M.crack);
    this.windscreen.visible = false;
    this.windscreen.renderOrder = 3;
    this.chassis.add(this.windscreen);

    for (const z of [-0.62, 0.62]) {
      const h = new THREE.Mesh(G.lamp, M.head);
      h.position.set(2.08, 0.78, z);
      const t = new THREE.Mesh(G.lamp, M.tail);
      t.position.set(-2.08, 0.8, z);
      this.lamps.push(h);
      this.tail.push(t);
      this.chassis.add(h, t);
    }

    roundelMat ??= new THREE.MeshBasicMaterial({ map: roundelTexture(), transparent: true });
    tapeMat ??= new THREE.MeshBasicMaterial({ map: tapeTexture(), transparent: true });
    for (const side of [-1, 1]) {
      const d = new THREE.Mesh(G.decal, roundelMat);
      d.position.set(-0.2, 0.72, side * 0.905);
      d.rotation.y = side > 0 ? 0 : Math.PI;
      const tape = new THREE.Mesh(G.tape, tapeMat);
      tape.position.set(-0.1, 0.5, side * 0.905);
      tape.rotation.y = side > 0 ? 0 : Math.PI;
      this.chassis.add(d, tape);
    }
    const roofDecal = new THREE.Mesh(G.decal, roundelMat);
    roofDecal.rotation.x = -Math.PI / 2;
    roofDecal.position.set(-1.0, 1.59, 0.4);
    this.chassis.add(roofDecal);
    if (airbag) {
      badgeMat ??= new THREE.MeshBasicMaterial({ map: sekiBadgeTexture(), transparent: true });
      const b = new THREE.Mesh(G.badge, badgeMat);
      b.rotation.x = -Math.PI / 2;
      b.position.set(-0.55, 1.59, -0.25);
      this.chassis.add(b);
    }

    this.dummy.position.set(-0.35, 0.95, 0.38);
    const torso = new THREE.Mesh(G.torso, M.dummyBody);
    torso.position.y = 0.2;
    const head = new THREE.Mesh(G.head, M.dummyHead);
    head.position.y = 0.48;
    this.dummy.add(torso, head);
    this.chassis.add(this.dummy);
    for (const [x, z, r] of [
      [0.25, 0.38, 1],
      [0.35, -0.38, 0.9],
    ]) {
      const a = new THREE.Mesh(G.airbag, M.airbag);
      a.position.set(x, 1.2, z);
      a.scale.setScalar(0.001 * r);
      a.visible = false;
      this.airbags.push(a);
      this.chassis.add(a);
    }

    for (const [x, z] of [
      [1.35, -0.8],
      [1.35, 0.8],
      [-1.35, -0.8],
      [-1.35, 0.8],
    ]) {
      const w = new THREE.Mesh(G.wheel, M.tyre);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.34, z);
      w.castShadow = true;
      const hub = new THREE.Mesh(G.hub, M.hub);
      w.add(hub);
      this.wheels.push(w);
      this.wheelX.push(x);
      this.group.add(w);
    }

    this.billboardTex = billboardTexture(name, sub, color);
    this.billboard = new THREE.Mesh(G.billboard, new THREE.MeshBasicMaterial({ map: this.billboardTex, transparent: true, depthWrite: false }));
    this.billboard.position.set(0, 3.0, 0);
    this.group.add(this.chassis, this.billboard);
  }

  private shapeBody(geo: THREE.BufferGeometry) {
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      let ny = y;
      let nz = z;
      if (x > 1.3 && y > 0) ny = y - 0.16 * ((x - 1.3) / 0.8);
      if (Math.abs(x) > 1.9) nz = z * (1 - 0.08 * ((Math.abs(x) - 1.9) / 0.2));
      if (y < 0 && Math.abs(x) > 1.8) ny = y + 0.08;
      p.setXYZ(i, x, ny, nz);
    }
    geo.computeVertexNormals();
  }

  private shapeCabin(geo: THREE.BufferGeometry) {
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const t = (y + 0.275) / 0.55;
      let nx = x - t * 0.6 * clamp01((x + 0.3) / 0.9);
      nx += t * 0.3 * clamp01((-0.75 - x) / 0.35);
      p.setXYZ(i, nx, y, p.getZ(i) * (1 - 0.04 * t));
    }
    geo.computeVertexNormals();
  }

  brake(ms = 900) {
    this.brakeUntil = performance.now() + ms;
  }

  setIdle(on: boolean) {
    this.idle = on;
  }

  /** Static pose (no sim running): sits on the floor at x with the persisted crush. */
  setStatic(x: number) {
    this.setPose({ x, y: 0, pitch: 0, crush: this.crush, airbag: this.airbagRest, dummy: 0 });
  }

  setPose(p: CarPose) {
    this.group.position.x = p.x;
    this.chassis.position.y = p.y;
    this.chassis.rotation.z = -p.pitch;
    if (Math.abs(p.crush - this.appliedCrush) > 0.0015) {
      this.appliedCrush = p.crush;
      this.applyCrush(p.crush);
    }
    for (const a of this.airbags) {
      a.visible = p.airbag > 0.01;
      a.scale.setScalar(Math.max(0.001, p.airbag));
    }
    this.dummy.rotation.z = -p.dummy;
  }

  /** Real vertex crush: nose folds back toward the barrier, bonnet peaks, wheels set back, glass cracks, lamps pop. */
  private applyCrush(c: number) {
    const pos = this.body.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const o = this.orig;
    const s = this.seed;
    for (let i = 0; i < arr.length; i += 3) {
      const ox = o[i];
      const oy = o[i + 1];
      const oz = o[i + 2];
      const f = clamp01((ox - 0.2) / 1.9);
      const a = c * sideWeight(oz);
      const fold = Math.pow(f, 1.3) * a;
      arr[i] = ox - CRUSH_MAX * fold + s[i] * 0.16 * a * f;
      arr[i + 1] = oy + a * f * (oy > 0.1 ? 0.2 : 0.05) + s[i + 1] * 0.13 * a * f;
      arr[i + 2] = oz + Math.sign(oz) * a * f * 0.12 + s[i + 2] * 0.1 * a * f;
    }
    pos.needsUpdate = true;
    this.body.geometry.computeVertexNormals();

    const bp = this.bonnet.geometry.attributes.position as THREE.BufferAttribute;
    const barr = bp.array as Float32Array;
    const ob = this.origBonnet;
    const sb = this.seedBonnet;
    for (let i = 0; i < barr.length; i += 3) {
      const lx = ob[i]; // −0.7 (windscreen edge) .. +0.7 (nose edge)
      const ly = ob[i + 1]; // across the car (world −z)
      const u = (lx + 0.7) / 1.4;
      const w = sideWeight(-ly);
      const tent = Math.max(0, 1 - Math.abs(u - 0.5) / 0.42);
      barr[i] = lx - CRUSH_MAX * c * w * u;
      barr[i + 1] = ly;
      barr[i + 2] = c * (0.42 * Math.pow(tent, 1.6) * (0.75 + 0.25 * w) + 0.12 * (1 - u) + 0.05 * sb[i] * (0.4 + w));
    }
    bp.needsUpdate = true;
    this.bonnet.geometry.computeVertexNormals();

    const cp = this.cabin.geometry.attributes.position as THREE.BufferAttribute;
    const carr = cp.array as Float32Array;
    for (let i = 0; i < carr.length; i += 3) {
      const ox = this.origCabin[i];
      const f = clamp01((ox + 0.6) / 1.2);
      carr[i] = ox - f * f * c * 0.12;
      carr[i + 1] = this.origCabin[i + 1] - f * c * 0.05;
      carr[i + 2] = this.origCabin[i + 2];
    }
    cp.needsUpdate = true;

    for (let k = 0; k < 2; k++) {
      const w = this.wheels[k];
      w.position.x = this.wheelX[k] - 0.34 * c * sideWeight(w.position.z);
      w.rotation.z = (w.position.z < 0 ? 1 : -1) * 0.12 * c;
    }
    for (const l of this.lamps) l.visible = c < 0.12;
    this.windscreen.visible = c > 0.2;
  }

  update(dt: number, speed: number, camera: THREE.Camera) {
    const rot = (speed * dt) / 0.34;
    for (const w of this.wheels) w.rotation.y -= rot;
    this.wobbleT += dt * 26;
    if (this.idle) this.chassis.position.y += Math.sin(this.wobbleT) * 0.006;
    const braking = performance.now() < this.brakeUntil;
    for (const t of this.tail) t.material = braking ? M.brake : M.tail;
    this.billboard.quaternion.copy(camera.quaternion);
  }

  dispose() {
    this.body.geometry.dispose();
    this.cabin.geometry.dispose();
    this.bonnet.geometry.dispose();
    this.windscreen.geometry.dispose();
    this.billboardTex.dispose();
    (this.billboard.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}
