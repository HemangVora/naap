import * as THREE from 'three';
import { PALETTE } from '../types';
import { drawRing, glowTexture, hazardTexture, plaqueTexture } from './textures';

export type GateState = 'idle' | 'safe' | 'paid' | 'stepup' | 'expired' | 'false_block';

const COL = {
  vermilion: new THREE.Color(PALETTE.vermilion),
  green: new THREE.Color(PALETTE.green),
  amber: new THREE.Color(PALETTE.amber),
  lantern: new THREE.Color('#ffb877'),
  yellow: new THREE.Color(PALETTE.yellow),
};

const G = {
  post: new THREE.BoxGeometry(0.28, 3.4, 0.28),
  kasagi: new THREE.BoxGeometry(0.5, 0.22, 4.4),
  nuki: new THREE.BoxGeometry(0.34, 0.16, 3.6),
  arm: new THREE.BoxGeometry(0.12, 0.14, 3.0),
  plaque: new THREE.PlaneGeometry(3.3, 1.35),
  lantern: new THREE.BoxGeometry(0.36, 0.5, 0.36),
  ring: new THREE.PlaneGeometry(1.5, 1.5),
  block: new THREE.BoxGeometry(1.3, 1.7, 2.7),
  blockFace: new THREE.PlaneGeometry(2.7, 1.7),
  foot: new THREE.BoxGeometry(1.6, 0.12, 3.0),
  glow: new THREE.PlaneGeometry(1, 1),
};
const M = {
  vermilion: new THREE.MeshStandardMaterial({ color: PALETTE.vermilion, roughness: 0.55 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.9 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x5b5d63, roughness: 0.95 }),
  hazard: null as THREE.MeshStandardMaterial | null,
  glowSprite: null as THREE.Texture | null,
};

function hazardMat() {
  M.hazard ??= new THREE.MeshStandardMaterial({ map: hazardTexture([2, 1]), roughness: 0.8 });
  return M.hazard;
}
function glowTex() {
  M.glowSprite ??= glowTexture();
  return M.glowSprite;
}

/** Vermilion sekisho gate: two posts, kasagi + nuki lintels, drop-arm, flip plaque, lanterns, countdown ring. */
export class Gate {
  group = new THREE.Group();
  private armPivot = new THREE.Group();
  private plaque: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private plaqueTex: THREE.CanvasTexture | null = null;
  private lanterns: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
  private lanternMat: THREE.MeshStandardMaterial;
  private glow: THREE.Sprite;
  private ring: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private ringCanvas: HTMLCanvasElement;
  private ringTex: THREE.CanvasTexture;
  private ringLast = -1;
  state: GateState = 'idle';
  private armTarget = -Math.PI / 2; // up
  private plaqueTarget = Math.PI / 2; // edge-on (hidden)
  private t = 0;
  stepUp?: { startedAt: number; expiresAt: number };

  constructor(x: number, z: number) {
    this.group.position.set(x, 0, z);
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(G.post, M.vermilion);
      p.position.set(0, 1.7, side * 1.7);
      p.castShadow = true;
      this.group.add(p);
    }
    const kasagi = new THREE.Mesh(G.kasagi, M.dark);
    kasagi.position.y = 3.5;
    const nuki = new THREE.Mesh(G.nuki, M.vermilion);
    nuki.position.y = 2.75;
    this.group.add(kasagi, nuki);

    // drop arm pivoting on the far post
    this.armPivot.position.set(0.3, 1.15, 1.7);
    const arm = new THREE.Mesh(G.arm, hazardMat());
    arm.position.z = -1.5;
    this.armPivot.add(arm);
    this.armPivot.rotation.x = this.armTarget;
    this.group.add(this.armPivot);

    // plaque hangs below the nuki, faces the camera (-z)
    this.plaque = new THREE.Mesh(G.plaque, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }));
    this.plaque.position.set(-0.05, 1.95, 0);
    this.plaque.rotation.set(this.plaqueTarget, Math.PI, 0);
    this.plaque.visible = false;
    this.group.add(this.plaque);

    // lanterns
    this.lanternMat = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: COL.lantern, emissiveIntensity: 1.4, roughness: 1 });
    for (const side of [-1, 1]) {
      const l = new THREE.Mesh(G.lantern, this.lanternMat);
      l.position.set(0, 3.95, side * 1.7);
      this.lanterns.push(l);
      this.group.add(l);
    }
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: COL.lantern, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.glow.scale.set(6, 6, 1);
    this.glow.position.set(0, 3.2, 0);
    this.group.add(this.glow);

    this.ringCanvas = document.createElement('canvas');
    this.ringCanvas.width = this.ringCanvas.height = 192;
    this.ringTex = new THREE.CanvasTexture(this.ringCanvas);
    this.ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ map: this.ringTex, transparent: true, depthWrite: false }));
    this.ring.position.set(0, 4.9, 0);
    this.ring.rotation.y = Math.PI;
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  setState(s: GateState, reason?: string, chips: string[] = []) {
    this.state = s;
    this.stepUp = undefined;
    const armDown = s === 'safe' || s === 'expired' || s === 'false_block';
    this.armTarget = armDown ? 0 : -Math.PI / 2;
    const c = s === 'paid' ? COL.green : s === 'stepup' ? COL.amber : s === 'idle' ? COL.lantern : s === 'false_block' ? COL.amber : COL.vermilion;
    this.lanternMat.emissive.copy(c);
    this.lanternMat.emissiveIntensity = s === 'idle' ? 1.4 : 3;
    this.glow.material.color.copy(c);
    this.glow.material.opacity = s === 'idle' ? 0.35 : 0.75;
    this.ring.visible = s === 'stepup';
    if (reason !== undefined) this.showPlaque(reason, chips, s === 'paid' ? 'green' : s === 'stepup' ? 'amber' : s === 'false_block' ? 'amber' : 'wood');
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
    this.plaque.rotation.x = Math.PI / 2 + 0.6; // wind up, then flip forward past 0 and settle
    this.plaqueTarget = 0;
  }

  update(dt: number) {
    this.t += dt;
    // arm: eased with a little bounce at the bottom
    const ad = this.armTarget - this.armPivot.rotation.x;
    this.armPivot.rotation.x += ad * Math.min(1, dt * 7);
    if (this.armTarget === 0 && Math.abs(ad) < 0.02) this.armPivot.rotation.x = Math.sin(this.t * 18) * 0.01 * Math.max(0, 1 - this.t % 1);
    // plaque flip with overshoot
    const pd = this.plaqueTarget - this.plaque.rotation.x;
    this.plaque.rotation.x += pd * Math.min(1, dt * 6);
    if (this.plaqueTarget > 1 && Math.abs(pd) < 0.05) this.plaque.visible = false;
    // pulse when stepping up
    if (this.state === 'stepup') {
      const p = 0.6 + 0.4 * Math.sin(this.t * 5);
      this.glow.material.opacity = 0.4 + 0.45 * p;
      this.lanternMat.emissiveIntensity = 2 + 2 * p;
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
    this.ring.rotation.z = 0;
  }
}

/** Concrete crash block for bare lanes with a hazard face and a lift (rises out of the way for PAID/SAFE). */
export class Block {
  group = new THREE.Group();
  private lift = 0;
  private liftTarget = 0;
  private wobble = 0;

  constructor(x: number, z: number) {
    this.group.position.set(x, 0, z);
    const b = new THREE.Mesh(G.block, M.concrete);
    b.position.set(0.65, 0.85, 0);
    b.castShadow = true;
    b.receiveShadow = true;
    const face = new THREE.Mesh(G.blockFace, hazardMat());
    face.position.set(-0.01, 0.85, 0);
    face.rotation.y = -Math.PI / 2;
    const foot = new THREE.Mesh(G.foot, M.dark);
    foot.position.set(0.65, 0.06, 0);
    this.group.add(b, face, foot);
  }

  raise(up: boolean) {
    this.liftTarget = up ? 2.4 : 0;
  }

  kick() {
    this.wobble = 1;
  }

  update(dt: number) {
    this.lift += (this.liftTarget - this.lift) * Math.min(1, dt * 4);
    this.wobble = Math.max(0, this.wobble - dt * 2.5);
    this.group.position.y = this.lift;
    this.group.rotation.z = Math.sin(this.wobble * 14) * 0.04 * this.wobble;
    this.group.position.x += 0; // keep static in x
  }
}
