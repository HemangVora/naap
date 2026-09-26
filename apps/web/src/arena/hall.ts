import * as THREE from 'three';
import { BARRIERS, BARRIER_LABEL } from '../types';
import { checkerTexture, floorTexture, hazardTexture, signTexture, stencilTexture, tickTexture } from './textures';
import { BRAND } from '../brand';

// Track runs along +x (screen left → right). Slots stack into depth along −z; the camera sits on +z.
export const STATION_X = [0, 22, 44, 66, 88];
export const START_X = -18;
export const END_X = 104;
export const SLOT_DZ = 8.2; // distance between lane pairs
export const LANE_DZ = 3.7; // bare lane sits this far behind (−z) the sekisho lane
export const MAX_SLOTS = 6;
export const slotZ = (slot: number) => -slot * SLOT_DZ;
export const laneZ = (slot: number, variant: 'bare' | 'airbag') => slotZ(slot) - (variant === 'bare' ? LANE_DZ : 0);
export const HALL_BG = '#dfe2e4';

const SUB: Record<string, string> = {
  legit: 'weather.naap.eth · $1.00',
  'grok-morse': 'morse reply · @drb_whale',
  freysa: 'inbox · pay() "receives"',
  'x402-swap': '402 payTo swapped',
  'over-limit': '$40 · cap $5 · World',
};

/** Bright NCAP hall: pale epoxy floor, white lane lines, metre ticks, floodlight banks, checkerboards, cable channels. */
export function buildHall(scene: THREE.Scene) {
  scene.background = new THREE.Color(HALL_BG);
  scene.fog = new THREE.Fog(HALL_BG, 260, 900);

  const wallZ = slotZ(MAX_SLOTS - 1) - LANE_DZ - 9;
  const midZ = (wallZ + 8) / 2;
  const depth = 8 - wallZ + 40;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(360, 200), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.85, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(44, 0, midZ);
  floor.receiveShadow = true;
  scene.add(floor);

  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf4f4f0 });
  const cableMat = new THREE.MeshBasicMaterial({ color: 0x3b3d42 });
  const tickMat = new THREE.MeshBasicMaterial({ map: tickTexture(), transparent: true, depthWrite: false });
  const len = END_X - START_X + 12;
  const cx = (START_X + END_X) / 2;
  const lineGeo = new THREE.PlaneGeometry(len, 0.08);
  const tickGeo = new THREE.PlaneGeometry(len, 0.5);
  const uv = tickGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * len); // one tick per metre
  for (let s = 0; s < MAX_SLOTS; s++) {
    for (const v of ['bare', 'airbag'] as const) {
      const z = laneZ(s, v);
      for (const dz of [-1.8, 1.8]) {
        const l = new THREE.Mesh(lineGeo, lineMat);
        l.rotation.x = -Math.PI / 2;
        l.position.set(cx, 0.006, z + dz);
        scene.add(l);
      }
      const cable = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.05), cableMat);
      cable.rotation.x = -Math.PI / 2;
      cable.position.set(cx, 0.007, z);
      scene.add(cable);
      const ticks = new THREE.Mesh(tickGeo, tickMat);
      ticks.rotation.x = -Math.PI / 2;
      ticks.position.set(cx, 0.008, z + 1.55);
      scene.add(ticks);
    }
  }

  const spanZ = SLOT_DZ * MAX_SLOTS + 4;
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(1.0, spanZ), new THREE.MeshBasicMaterial({ map: hazardTexture([1, 14]) }));
  startLine.rotation.x = -Math.PI / 2;
  startLine.position.set(START_X + 2, 0.009, midZ + 6);
  scene.add(startLine);

  BARRIERS.forEach((b, i) => {
    const t = stencilTexture(BARRIER_LABEL[b], SUB[b]);
    const mat = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
    const near = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.5), mat);
    near.rotation.x = -Math.PI / 2;
    near.position.set(STATION_X[i] - 1, 0.011, 5.6);
    scene.add(near);
    const far = near.clone();
    far.position.z = wallZ + 5;
    scene.add(far);
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.35, spanZ + 8), new THREE.MeshBasicMaterial({ color: 0x8d9094 }));
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(STATION_X[i], 0.005, midZ + 4);
    scene.add(stripe);
  });

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 1 });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(360, 16), wallMat);
  wall.position.set(44, 8, wallZ);
  scene.add(wall);
  const sideWall = new THREE.Mesh(new THREE.PlaneGeometry(depth + 60, 16), wallMat);
  sideWall.rotation.y = Math.PI / 2;
  sideWall.position.set(START_X - 40, 8, midZ);
  scene.add(sideWall);
  const checker = new THREE.MeshStandardMaterial({ map: checkerTexture(8), roughness: 1 });
  for (const x of STATION_X) {
    for (const dx of [-4.5, 4.5]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), checker);
      panel.position.set(x + dx, 2.4, wallZ + 0.05);
      scene.add(panel);
    }
    const stand = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), checker);
    stand.position.set(x + 6.5, 1.65, wallZ + 3);
    scene.add(stand);
  }
  const signMat = new THREE.MeshBasicMaterial({ map: signTexture(BRAND.name, BRAND.long) });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(16, 4), signMat); // far wall only, low, between the checkerboards
  sign.position.set(STATION_X[2] + 11, 3.0, wallZ + 0.08);
  scene.add(sign);
  const skirt = new THREE.Mesh(new THREE.PlaneGeometry(360, 0.5), new THREE.MeshBasicMaterial({ map: hazardTexture([90, 1]) }));
  skirt.position.set(44, 0.25, wallZ + 0.06);
  scene.add(skirt);

  const bankGeo = new THREE.BoxGeometry(7, 0.25, 2.2);
  const bankMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6 });
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.6, metalness: 0.6 });
  for (let x = START_X - 6; x <= END_X + 6; x += 12) {
    for (let z = 6; z > wallZ; z -= 9) {
      const bank = new THREE.Mesh(bankGeo, bankMat);
      bank.position.set(x, 12.5, z);
      bank.layers.set(1); // ceiling is seen by the side-on high-speed cam only; the gantry shot looks down through it
      scene.add(bank);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, depth + 30), trussMat);
    beam.position.set(x, 13.2, midZ);
    beam.layers.set(1);
    scene.add(beam);
  }

  scene.add(new THREE.HemisphereLight(0xffffff, 0xb7bab6, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(30, 40, 30);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 5;
  key.shadow.camera.far = 140;
  key.shadow.camera.left = -60;
  key.shadow.camera.right = 60;
  key.shadow.camera.top = 60;
  key.shadow.camera.bottom = -60;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xe8f0ff, 0.9);
  fill.position.set(-40, 25, -30);
  scene.add(fill);

  return { key, wallZ };
}
