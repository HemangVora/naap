import * as THREE from 'three';
import { billboardTexture, roundelTexture, sekiBadgeTexture } from './textures';

// Shared geometries/materials (one set for every car; only the body is cloned so it can dent).
const G = {
  body: new THREE.BoxGeometry(3.2, 0.8, 1.6, 8, 3, 4),
  cabin: new THREE.BoxGeometry(1.5, 0.62, 1.34, 4, 2, 3),
  wheel: new THREE.CylinderGeometry(0.36, 0.36, 0.3, 14),
  hub: new THREE.CylinderGeometry(0.16, 0.16, 0.32, 8),
  bumper: new THREE.BoxGeometry(0.18, 0.3, 1.5),
  decal: new THREE.PlaneGeometry(0.62, 0.62),
  badge: new THREE.PlaneGeometry(0.62, 0.62),
  lamp: new THREE.BoxGeometry(0.06, 0.16, 0.3),
  billboard: new THREE.PlaneGeometry(3.2, 1),
};
const M = {
  tyre: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.95 }),
  hub: new THREE.MeshStandardMaterial({ color: 0xbdbdb8, roughness: 0.4, metalness: 0.7 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x9fd2ff, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.85 }),
  bumper: new THREE.MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.8 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c2, emissiveIntensity: 2.2 }),
  tail: new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 1.6 }),
  brake: new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 5 }),
};
let roundelMat: THREE.MeshBasicMaterial | null = null;
let badgeMat: THREE.MeshBasicMaterial | null = null;

const bodyMatCache = new Map<string, THREE.MeshStandardMaterial>();
function bodyMaterial(color: string) {
  let m = bodyMatCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.42, metalness: 0.25 });
    bodyMatCache.set(color, m);
  }
  return m;
}

export class CarMesh {
  group = new THREE.Group();
  body: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  cabin: THREE.Mesh;
  chassis = new THREE.Group(); // everything that squashes/tilts
  wheels: THREE.Mesh[] = [];
  private tail: THREE.Mesh[] = [];
  private billboard: THREE.Mesh;
  private billboardTex: THREE.CanvasTexture;
  private orig: Float32Array;
  private origCabin: Float32Array;
  private dentSeed: Float32Array;
  private cabinSeed: Float32Array;
  crumple = 0; // 0..1 applied
  private crumpleTarget = 0;
  private crumpleVel = 0;
  private squash = 0;
  private pitch = 0;
  private pitchVel = 0;
  private wobbleT = Math.random() * 10;
  private idleWobble = 0;
  private brakeUntil = 0;

  constructor(public name: string, sub: string, public color: string, airbag: boolean) {
    const bodyGeo = G.body.clone();
    const cabinGeo = G.cabin.clone();
    this.orig = (bodyGeo.attributes.position.array as Float32Array).slice();
    this.origCabin = (cabinGeo.attributes.position.array as Float32Array).slice();
    this.dentSeed = new Float32Array(this.orig.length).map(() => Math.random() - 0.5);
    this.cabinSeed = new Float32Array(this.origCabin.length).map(() => Math.random() - 0.5);

    const mat = bodyMaterial(color);
    this.body = new THREE.Mesh(bodyGeo, mat);
    this.body.position.y = 0.72;
    this.body.castShadow = true;
    this.cabin = new THREE.Mesh(cabinGeo, M.glass);
    this.cabin.position.set(-0.25, 1.4, 0);
    this.cabin.castShadow = true;
    this.chassis.add(this.body, this.cabin);

    // roof band in body colour so the cabin is not pure glass
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.06, 1.2), mat);
    roof.position.set(-0.25, 1.74, 0);
    this.chassis.add(roof);

    const bumperF = new THREE.Mesh(G.bumper, M.bumper);
    bumperF.position.set(1.66, 0.5, 0);
    const bumperB = bumperF.clone();
    bumperB.position.x = -1.66;
    this.chassis.add(bumperF, bumperB);

    for (const z of [-0.62, 0.62]) {
      const h = new THREE.Mesh(G.lamp, M.head);
      h.position.set(1.62, 0.86, z);
      const t = new THREE.Mesh(G.lamp, M.tail);
      t.position.set(-1.62, 0.86, z);
      this.tail.push(t);
      this.chassis.add(h, t);
    }

    roundelMat ??= new THREE.MeshBasicMaterial({ map: roundelTexture(), transparent: true });
    for (const side of [-1, 1]) {
      const d = new THREE.Mesh(G.decal, roundelMat);
      d.position.set(0.55, 0.8, side * 0.81);
      d.rotation.y = side > 0 ? 0 : Math.PI;
      this.chassis.add(d);
    }
    if (airbag) {
      badgeMat ??= new THREE.MeshBasicMaterial({ map: sekiBadgeTexture(), transparent: true });
      const b = new THREE.Mesh(G.badge, badgeMat);
      b.rotation.x = -Math.PI / 2;
      b.position.set(-0.25, 1.78, 0);
      this.chassis.add(b);
    }

    for (const [x, z] of [
      [1.05, -0.78],
      [1.05, 0.78],
      [-1.05, -0.78],
      [-1.05, 0.78],
    ]) {
      const w = new THREE.Mesh(G.wheel, M.tyre);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.36, z);
      w.castShadow = true;
      const hub = new THREE.Mesh(G.hub, M.hub);
      w.add(hub);
      this.wheels.push(w);
      this.group.add(w);
    }

    this.billboardTex = billboardTexture(name, sub, color);
    this.billboard = new THREE.Mesh(G.billboard, new THREE.MeshBasicMaterial({ map: this.billboardTex, transparent: true, depthWrite: false }));
    this.billboard.position.set(0, 3.1, 0);
    this.group.add(this.chassis, this.billboard);
  }

  /** Hard hit against the wall: dents the body toward the impact, squashes, pitches the nose down. */
  hit(strength = 1) {
    this.crumpleTarget = Math.min(1, this.crumpleTarget + 0.55 * strength);
    this.crumpleVel = 6;
    this.squash = 1;
    this.pitchVel = 7 * strength;
    this.brakeUntil = performance.now() + 1500;
  }

  brake(ms = 900) {
    this.brakeUntil = performance.now() + ms;
    this.pitchVel = Math.max(this.pitchVel, 1.8);
  }

  setIdle(on: boolean) {
    this.idleWobble = on ? 1 : 0;
  }

  update(dt: number, speed: number, camera: THREE.Camera) {
    // wheels roll with speed
    const rot = (speed * dt) / 0.36;
    for (const w of this.wheels) w.rotation.y -= rot;

    // crumple springs toward target (overshoot then settle)
    if (Math.abs(this.crumple - this.crumpleTarget) > 0.001 || Math.abs(this.crumpleVel) > 0.001) {
      const k = 90;
      const d = 9;
      const acc = (this.crumpleTarget - this.crumple) * k - this.crumpleVel * d;
      this.crumpleVel += acc * dt;
      this.crumple += this.crumpleVel * dt;
      this.applyCrumple();
    }
    // squash & stretch pop
    if (this.squash > 0) {
      this.squash = Math.max(0, this.squash - dt * 4);
      const s = this.squash;
      const e = Math.sin(s * Math.PI) * 0.22;
      this.chassis.scale.set(1 - e, 1 + e * 0.8, 1 + e * 0.5);
    } else this.chassis.scale.setScalar(1);

    // pitch spring (brake dive / impact)
    const pacc = -this.pitch * 60 - this.pitchVel * 8;
    this.pitchVel += pacc * dt;
    this.pitch += this.pitchVel * dt;
    this.chassis.rotation.z = -this.pitch * 0.09;

    // engine idle wobble
    this.wobbleT += dt * 26;
    const wob = this.idleWobble * 0.012;
    this.chassis.position.y = Math.sin(this.wobbleT) * wob + Math.sin(this.wobbleT * 0.37) * wob;
    this.chassis.rotation.x = Math.sin(this.wobbleT * 0.9) * wob * 0.6;

    const braking = performance.now() < this.brakeUntil;
    for (const t of this.tail) t.material = braking ? M.brake : M.tail;

    this.billboard.quaternion.copy(camera.quaternion);
    // hide the name card in close-ups so it does not fill the frame
    this.billboard.visible = camera.position.distanceToSquared(this.group.position) > 12 * 12;
  }

  private applyCrumple() {
    const a = Math.max(0, this.crumple);
    const pos = this.body.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const ox = this.orig[i];
      const oy = this.orig[i + 1];
      const oz = this.orig[i + 2];
      // impact influence: front of the car (+x) folds back
      const f = THREE.MathUtils.clamp((ox + 0.2) / 1.8, 0, 1);
      const fold = f * f * a;
      arr[i] = ox - fold * 1.15 + this.dentSeed[i] * 0.22 * a * f;
      arr[i + 1] = oy + fold * 0.32 * (oy > 0 ? 1 : 0.2) + this.dentSeed[i + 1] * 0.18 * a * (0.3 + f);
      arr[i + 2] = oz * (1 + fold * 0.22) + this.dentSeed[i + 2] * 0.16 * a * (0.3 + f);
    }
    pos.needsUpdate = true;
    this.body.geometry.computeVertexNormals();

    const cpos = this.cabin.geometry.attributes.position as THREE.BufferAttribute;
    const carr = cpos.array as Float32Array;
    for (let i = 0; i < carr.length; i += 3) {
      const ox = this.origCabin[i];
      const f = THREE.MathUtils.clamp((ox + 0.75) / 1.5, 0, 1);
      carr[i] = ox - f * f * a * 0.35 + this.cabinSeed[i] * 0.12 * a;
      carr[i + 1] = this.origCabin[i + 1] - f * a * 0.12 + this.cabinSeed[i + 1] * 0.1 * a;
      carr[i + 2] = this.origCabin[i + 2] + this.cabinSeed[i + 2] * 0.1 * a;
    }
    cpos.needsUpdate = true;
    this.cabin.geometry.computeVertexNormals();
  }

  dispose() {
    this.body.geometry.dispose();
    this.cabin.geometry.dispose();
    this.billboardTex.dispose();
    (this.billboard.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}
