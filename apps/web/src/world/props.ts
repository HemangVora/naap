import * as THREE from 'three';
import type { BarrierId, TrackObstacle } from '../types';
import { PALETTE } from '../types';
import { drawMorse, inboxTexture, kioskTexture, x402SignTexture } from './tex';

// One physical prop per obstacle type, recognisable from the air. They stand on the far verge beside the station.

const M = {
  post: new THREE.MeshStandardMaterial({ color: 0x5d6068, roughness: 0.6, metalness: 0.5 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.8 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.7 }),
  yellow: new THREE.MeshStandardMaterial({ color: PALETTE.yellow, roughness: 0.6 }),
  vermilion: new THREE.MeshStandardMaterial({ color: PALETTE.vermilion, roughness: 0.55 }),
  glassBooth: new THREE.MeshStandardMaterial({ color: 0x9fc4d8, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.55 }),
  blink: new THREE.MeshStandardMaterial({ color: PALETTE.vermilion, emissive: PALETTE.vermilion, emissiveIntensity: 2 }),
};
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const G = {
  post: new THREE.CylinderGeometry(0.16, 0.2, 1, 8),
  booth: box(2.6, 2.8, 2.4),
  boothRoof: box(4.2, 0.35, 3.6),
  screen: new THREE.PlaneGeometry(1.6, 1.6),
  billboard: box(9, 4.6, 0.4),
  bbFace: new THREE.PlaneGeometry(8.6, 4.2),
  tower: box(3.2, 9, 3.2),
  towerFace: new THREE.PlaneGeometry(3.0, 6.0),
  towerCap: box(3.8, 0.5, 3.8),
  blink: new THREE.SphereGeometry(0.45, 12, 8),
  sign: new THREE.PlaneGeometry(6, 6),
  base: box(1.2, 0.4, 1.2),
};

// one shared Morse screen, animated at ~10 Hz for every billboard
let morseCanvas: HTMLCanvasElement | null = null;
let morseTex: THREE.CanvasTexture | null = null;
let morseMat: THREE.MeshBasicMaterial | null = null;
let morseLast = -1;
function morseMaterial() {
  if (!morseMat) {
    morseCanvas = document.createElement('canvas');
    morseCanvas.width = 512;
    morseCanvas.height = 256;
    drawMorse(morseCanvas, 0);
    morseTex = new THREE.CanvasTexture(morseCanvas);
    morseTex.colorSpace = THREE.SRGBColorSpace;
    morseMat = new THREE.MeshBasicMaterial({ map: morseTex, toneMapped: false });
  }
  return morseMat;
}
let inboxMat: THREE.MeshStandardMaterial | null = null;
let signMat: THREE.MeshStandardMaterial | null = null;
const kioskMats = new Map<string, THREE.MeshBasicMaterial>();

export function tickProps(t: number) {
  const q = Math.floor(t * 10);
  if (morseCanvas && morseTex && q !== morseLast) {
    morseLast = q;
    drawMorse(morseCanvas, t);
    morseTex.needsUpdate = true;
  }
  M.blink.emissiveIntensity = Math.sin(t * 6) > 0 ? 2.4 : 0.2;
}

function post(h: number, x: number, z: number) {
  const p = new THREE.Mesh(G.post, M.post);
  p.scale.y = h;
  p.position.set(x, h / 2, z);
  p.castShadow = true;
  return p;
}

/** Build the prop for one obstacle. Local frame: origin at the station on the far verge, the road lies toward +z. */
export function buildProp(ob: TrackObstacle): THREE.Group {
  const g = new THREE.Group();
  const type: BarrierId = ob.type;
  if (type === 'legit' || type === 'over-limit') {
    // toll booth with a payment kiosk screen facing the road
    const booth = new THREE.Mesh(G.booth, M.white);
    booth.position.y = 1.4;
    booth.castShadow = true;
    const glass = new THREE.Mesh(box(2.64, 1.1, 2.44), M.glassBooth);
    glass.position.y = 2.0;
    const roof = new THREE.Mesh(G.boothRoof, type === 'legit' ? M.yellow : M.vermilion);
    roof.position.y = 3.0;
    roof.castShadow = true;
    const amt = ob.amountUsd ?? ob.custom?.amountUsd ?? (type === 'legit' ? 1 : 40);
    const price = `$${amt % 1 ? amt.toFixed(2) : amt}`;
    const k = `${type}:${price}`;
    let mat = kioskMats.get(k);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ map: kioskTexture(price, type === 'legit' ? 'GPU compute · $1' : 'cap $5 · owner', type !== 'legit'), toneMapped: false });
      kioskMats.set(k, mat);
    }
    const screen = new THREE.Mesh(G.screen, mat);
    screen.position.set(0, 1.4, 1.21);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), mat);
    sign.position.set(0, 5.4, 0);
    sign.rotation.x = -0.5;
    g.add(booth, glass, roof, screen, sign, post(3.6, 0, -0.2));
  } else if (type === 'grok-morse') {
    const frame = new THREE.Mesh(G.billboard, M.dark);
    frame.position.y = 6.2;
    frame.castShadow = true;
    const face = new THREE.Mesh(G.bbFace, morseMaterial());
    face.position.set(0, 6.2, 0.21);
    g.add(frame, face, post(4.2, -2.8, 0), post(4.2, 2.8, 0));
    const lip = new THREE.Mesh(box(9.2, 0.25, 0.9), M.yellow);
    lip.position.set(0, 3.8, 0.3);
    g.add(lip);
  } else if (type === 'freysa') {
    inboxMat ??= new THREE.MeshStandardMaterial({ map: inboxTexture(), roughness: 0.7 });
    const tower = new THREE.Mesh(G.tower, M.white);
    tower.position.y = 4.5;
    tower.castShadow = true;
    const face = new THREE.Mesh(G.towerFace, inboxMat);
    face.position.set(0, 5.0, 1.61);
    const cap = new THREE.Mesh(G.towerCap, M.vermilion);
    cap.position.y = 9.25;
    cap.castShadow = true;
    const light = new THREE.Mesh(G.blink, M.blink);
    light.position.set(0, 9.9, 0);
    g.add(tower, face, cap, light);
  } else if (type === 'x402-swap') {
    signMat ??= new THREE.MeshStandardMaterial({ map: x402SignTexture(), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6 });
    const s = new THREE.Mesh(G.sign, signMat);
    s.position.set(0, 6.2, 0.2);
    s.castShadow = true;
    const base = new THREE.Mesh(G.base, M.dark);
    base.position.y = 0.2;
    g.add(s, post(6.2, -1.6, 0), post(6.2, 1.6, 0), base);
  }
  return g;
}
