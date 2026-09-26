import * as THREE from 'three';
import { PALETTE } from '../types';
import { drawRing, glowTexture, hazardTexture, honeycombTexture, plaqueTexture } from './textures';

export type GateState = 'idle' | 'safe' | 'paid' | 'stepup' | 'expired' | 'false_block';
export type GateStyle = 'sekisho' | 'toll';

const COL = {
  vermilion: new THREE.Color(PALETTE.vermilion),
  green: new THREE.Color(PALETTE.green),
  amber: new THREE.Color(PALETTE.amber),
  lantern: new THREE.Color('#ffb877'),
};

const G = {
  post: new THREE.BoxGeometry(0.28, 3.4, 0.28),
  tollPost: new THREE.BoxGeometry(0.3, 1.4, 0.3),
  kasagi: new THREE.BoxGeometry(0.5, 0.22, 4.4),
  nuki: new THREE.BoxGeometry(0.34, 0.16, 3.6),
  arm: new THREE.BoxGeometry(0.12, 0.14, 3.0),
  plaque: new THREE.PlaneGeometry(3.3, 1.35),
  lantern: new THREE.BoxGeometry(0.36, 0.5, 0.36),
  ring: new THREE.PlaneGeometry(1.5, 1.5),
  block: new THREE.BoxGeometry(2.2, 1.9, 3.0),
  frame: new THREE.BoxGeometry(0.14, 1.5, 1.6),
  comb: new THREE.BoxGeometry(0.42, 1.3, 1.35),
  face: new THREE.PlaneGeometry(1.35, 1.3, 12, 10),
  foot: new THREE.BoxGeometry(2.6, 0.1, 3.4),
  gvt: new THREE.BoxGeometry(3.6, 1.05, 1.7),
  gvtCabin: new THREE.BoxGeometry(1.9, 0.55, 1.5),
};
const M = {
  vermilion: new THREE.MeshStandardMaterial({ color: PALETTE.vermilion, roughness: 0.55 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.9 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8f9298, roughness: 0.5, metalness: 0.6 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x9d9e9a, roughness: 0.95 }),
  trolley: new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.6 }),
  combSide: new THREE.MeshStandardMaterial({ color: 0xd8d2b4, roughness: 0.5, metalness: 0.5 }),
  gvt: new THREE.MeshStandardMaterial({ color: 0xe9ebe8, roughness: 1 }),
  gvtDark: new THREE.MeshStandardMaterial({ color: 0x3c3f45, roughness: 1 }),
  hazard: null as THREE.MeshStandardMaterial | null,
  comb: null as THREE.MeshStandardMaterial | null,
  glowSprite: null as THREE.Texture | null,
};
const hazardMat = () => (M.hazard ??= new THREE.MeshStandardMaterial({ map: hazardTexture([2, 1]), roughness: 0.8 }));
const combMat = () => (M.comb ??= new THREE.MeshStandardMaterial({ map: honeycombTexture(), roughness: 0.45, metalness: 0.55 }));
const glowTex = () => (M.glowSprite ??= glowTexture());

/** Vermilion sekisho gate (or a grey toll gate): posts, lintels, drop-arm (AEB trigger), flip plaque, countdown ring. */
export class Gate {
  group = new THREE.Group();
  private armPivot = new THREE.Group();
  private plaque: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private plaqueTex: THREE.CanvasTexture | null = null;
  private lanternMat: THREE.MeshStandardMaterial;
  private glow: THREE.Sprite;
  private ring: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private ringCanvas: HTMLCanvasElement;
  private ringTex: THREE.CanvasTexture;
  private ringLast = -1;
  state: GateState = 'idle';
  private armTarget = -Math.PI / 2;
  private plaqueTarget = Math.PI / 2;
  private t = 0;
  stepUp?: { startedAt: number; expiresAt: number };

  constructor(x: number, z: number, public style: GateStyle = 'sekisho') {
    this.group.position.set(x, 0, z);
    const sek = style === 'sekisho';
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(sek ? G.post : G.tollPost, sek ? M.vermilion : M.steel);
      p.position.set(0, sek ? 1.7 : 0.7, side * 1.75);
      p.castShadow = true;
      this.group.add(p);
    }
    if (sek) {
      const kasagi = new THREE.Mesh(G.kasagi, M.dark);
      kasagi.position.y = 3.5;
      const nuki = new THREE.Mesh(G.nuki, M.vermilion);
      nuki.position.y = 2.75;
      this.group.add(kasagi, nuki);
    }
    this.armPivot.position.set(0.25, 1.15, -1.75);
    const arm = new THREE.Mesh(G.arm, hazardMat());
    arm.position.z = 1.5;
    this.armPivot.add(arm);
    this.armPivot.rotation.x = this.armTarget;
    this.group.add(this.armPivot);

    this.plaque = new THREE.Mesh(G.plaque, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }));
    this.plaque.position.set(-0.05, sek ? 1.95 : 1.9, 0.1);
    this.plaque.rotation.set(this.plaqueTarget, 0, 0);
    this.plaque.visible = false;
    this.group.add(this.plaque);

    this.lanternMat = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: COL.lantern, emissiveIntensity: 0.6, roughness: 1 });
    for (const side of [-1, 1]) {
      const l = new THREE.Mesh(G.lantern, this.lanternMat);
      l.position.set(0, sek ? 3.95 : 1.65, side * 1.75);
      this.group.add(l);
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: COL.lantern, transparent: true, opacity: 0.0, depthWrite: false }));
    this.glow.scale.set(5, 5, 1);
    this.glow.position.set(0, 3.0, 0);
    this.group.add(this.glow);

    this.ringCanvas = document.createElement('canvas');
    this.ringCanvas.width = this.ringCanvas.height = 192;
    this.ringTex = new THREE.CanvasTexture(this.ringCanvas);
    this.ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ map: this.ringTex, transparent: true, depthWrite: false }));
    this.ring.position.set(0, sek ? 4.9 : 3.2, 0);
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  setState(s: GateState, reason?: string, chips: string[] = []) {
    this.state = s;
    this.stepUp = undefined;
    const armDown = s === 'safe' || s === 'expired' || s === 'false_block';
    this.armTarget = armDown ? 0 : -Math.PI / 2;
    const c = s === 'paid' ? COL.green : s === 'stepup' || s === 'false_block' ? COL.amber : s === 'idle' ? COL.lantern : COL.vermilion;
    this.lanternMat.emissive.copy(c);
    this.lanternMat.emissiveIntensity = s === 'idle' ? 0.6 : 2.5;
    this.glow.material.color.copy(c);
    this.glow.material.opacity = s === 'idle' ? 0 : 0.45;
    this.ring.visible = s === 'stepup';
    if (reason !== undefined) this.showPlaque(reason, chips, s === 'paid' ? 'green' : s === 'stepup' || s === 'false_block' ? 'amber' : 'wood');
    else if (s === 'idle') this.plaqueTarget = Math.PI / 2;
  }

  startStepUp(startedAt: number, expiresAt: number) {
    this.stepUp = { startedAt, expiresAt };
    this.ringLast = -1;
  }

  private showPlaque(reason: string, chips: string[], tone: 'wood' | 'green' | 'amber') {
    this.plaqueTex?.dispose();
    this.plaqueTex = plaqueTexture(reason, chips, tone);
    this.plaque.material.map = this.plaqueTex;
    this.plaque.material.needsUpdate = true;
    this.plaque.visible = true;
    this.plaque.rotation.x = Math.PI / 2 + 0.6;
    this.plaqueTarget = 0;
  }

  update(dt: number) {
    this.t += dt;
    const ad = this.armTarget - this.armPivot.rotation.x;
    this.armPivot.rotation.x += ad * Math.min(1, dt * 9);
    const pd = this.plaqueTarget - this.plaque.rotation.x;
    this.plaque.rotation.x += pd * Math.min(1, dt * 6);
    if (this.plaqueTarget > 1 && Math.abs(pd) < 0.05) this.plaque.visible = false;
    if (this.state === 'stepup') {
      const p = 0.6 + 0.4 * Math.sin(this.t * 5);
      this.glow.material.opacity = 0.25 + 0.35 * p;
      this.lanternMat.emissiveIntensity = 1.5 + 2 * p;
      if (this.stepUp) {
        const total = Math.max(1, this.stepUp.expiresAt - this.stepUp.startedAt);
        const left = Math.max(0, (this.stepUp.expiresAt - Date.now()) / total);
        const q = Math.round(left * 60);
        if (q !== this.ringLast) {
          this.ringLast = q;
          drawRing(this.ringCanvas, left);
          this.ringTex.needsUpdate = true;
        }
      }
    }
  }

  dispose() {
    this.plaqueTex?.dispose();
    this.ringTex.dispose();
    this.group.removeFromParent();
  }
}

/** Concrete reaction block with a deformable aluminium honeycomb face (offset: covers the far half of the lane). */
export class Barrier {
  group = new THREE.Group();
  private face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private faceOrig: Float32Array;
  private lift = 0;
  private liftTarget = 0;
  private dent = 0;
  private appliedDent = -1;
  /** world x of the honeycomb face the car hits */
  faceX: number;

  constructor(x: number, z: number) {
    this.group.position.set(x, 0, z);
    this.faceX = x;
    const b = new THREE.Mesh(G.block, M.concrete);
    b.position.set(1.55, 0.95, -0.2);
    b.castShadow = true;
    b.receiveShadow = true;
    const foot = new THREE.Mesh(G.foot, M.dark);
    foot.position.set(1.55, 0.05, -0.2);
    const frame = new THREE.Mesh(G.frame, M.trolley);
    frame.position.set(0.48, 0.85, -0.55);
    const comb = new THREE.Mesh(G.comb, M.combSide);
    comb.position.set(0.22, 0.85, -0.55);
    comb.castShadow = true;
    this.face = new THREE.Mesh(G.face.clone(), combMat());
    this.face.position.set(0.005, 0.85, -0.55);
    this.face.rotation.y = -Math.PI / 2;
    this.faceOrig = (this.face.geometry.attributes.position.array as Float32Array).slice();
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.25, 3.04), hazardMat());
    stripe.position.set(1.55, 1.75, -0.2);
    this.group.add(b, foot, frame, comb, this.face, stripe);
  }

  raise(up: boolean) {
    this.liftTarget = up ? 2.8 : 0;
  }

  /** Dent depth 0..1 where the car's nose hits. Deterministic in the crash sim. */
  setDent(d: number) {
    this.dent = d;
  }

  update(dt: number) {
    this.lift += (this.liftTarget - this.lift) * Math.min(1, dt * 3);
    this.group.position.y = this.lift;
    if (Math.abs(this.dent - this.appliedDent) > 0.002) {
      this.appliedDent = this.dent;
      const p = this.face.geometry.attributes.position as THREE.BufferAttribute;
      const arr = p.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const lx = this.faceOrig[i];
        const ly = this.faceOrig[i + 1];
        const g = Math.exp(-((ly + 0.25) * (ly + 0.25)) / 0.22) * (0.55 + 0.45 * Math.max(0, 1 - Math.abs(lx + 0.15) / 0.8));
        arr[i + 2] = -0.4 * this.dent * g;
      }
      p.needsUpdate = true;
      this.face.geometry.computeVertexNormals();
    }
  }

  dispose() {
    this.face.geometry.dispose();
    this.group.removeFromParent();
  }
}

/** Soft inflatable target car (GVT) the AEB test stops short of. Lifts away when the lane must clear. */
export class SoftTarget {
  group = new THREE.Group();
  private lift = 0;
  private liftTarget = 0;
  /** world x of the target's rear bumper */
  rearX: number;

  constructor(x: number, z: number) {
    this.group.position.set(x, 0, z);
    this.rearX = x - 1.8;
    const body = new THREE.Mesh(G.gvt, M.gvt);
    body.position.y = 0.72;
    body.castShadow = true;
    const cabin = new THREE.Mesh(G.gvtCabin, M.gvtDark);
    cabin.position.set(-0.2, 1.5, 0);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.35), hazardMat());
    plate.position.set(-1.81, 0.55, 0);
    plate.rotation.y = -Math.PI / 2;
    this.group.add(body, cabin, plate);
  }

  raise(up: boolean) {
    this.liftTarget = up ? 3 : 0;
  }

  update(dt: number) {
    this.lift += (this.liftTarget - this.lift) * Math.min(1, dt * 3);
    this.group.position.y = this.lift;
  }

  dispose() {
    this.group.removeFromParent();
  }
}

/** Skid-mark decal pair left on the floor by an AEB stop. */
export function skidMarks(scene: THREE.Scene, xEnd: number, z: number, length: number) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x1c1c1e, transparent: true, opacity: 0.5, depthWrite: false });
  const geo = new THREE.PlaneGeometry(length, 0.26);
  const out: THREE.Mesh[] = [];
  for (const dz of [-0.8, 0.8]) {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(xEnd - length / 2, 0.013, z + dz);
    scene.add(m);
    out.push(m);
  }
  return out;
}
