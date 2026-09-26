import * as THREE from 'three';
import { PALETTE, BARRIERS, BARRIER_LABEL } from '../types';
import { checkerTexture, floorTexture, hazardTexture, stencilTexture } from './textures';

export const STATION_X = [0, 22, 44, 66, 88];
export const START_X = -20;
export const END_X = 108;
export const SLOT_DZ = 7.2; // distance between lane pairs
export const LANE_DZ = 3.2; // bare lane sits this far behind the airbag lane
export const MAX_SLOTS = 6;
export const slotZ = (slot: number) => slot * SLOT_DZ;
export const laneZ = (slot: number, variant: 'bare' | 'airbag') => slotZ(slot) + (variant === 'bare' ? LANE_DZ : 0);

const SUB: Record<string, string> = {
  legit: 'weather.crumple.eth · $1.00',
  'grok-morse': 'morse reply · @drb_whale',
  freysa: 'inbox · pay() "receives"',
  'x402-swap': '402 payTo swapped',
  'over-limit': '$40 · cap $5 · World',
};

/** Builds the static hall: floor, walls, strip lights, checkerboards, station labels, fog. */
export function buildHall(scene: THREE.Scene) {
  scene.background = new THREE.Color(PALETTE.charcoal);
  scene.fog = new THREE.FogExp2(PALETTE.charcoal, 0.011);

  // floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(320, 160), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.95, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(44, 0, 20);
  floor.receiveShadow = true;
  scene.add(floor);

  // lane guide lines (thin yellow) for each of the 12 lanes
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x3a3a2a });
  for (let s = 0; s < MAX_SLOTS; s++) {
    for (const v of ['bare', 'airbag'] as const) {
      const z = laneZ(s, v);
      const l = new THREE.Mesh(new THREE.PlaneGeometry(END_X - START_X + 10, 0.06), lineMat);
      l.rotation.x = -Math.PI / 2;
      l.position.set((START_X + END_X) / 2, 0.005, z - 1.55);
      scene.add(l);
      const r = l.clone();
      r.position.z = z + 1.55;
      scene.add(r);
    }
  }
  // start line, hazard
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(1.2, MAX_SLOTS * SLOT_DZ + 4), new THREE.MeshBasicMaterial({ map: hazardTexture([1, 12]) }));
  startLine.rotation.x = -Math.PI / 2;
  startLine.position.set(START_X + 3, 0.006, (MAX_SLOTS * SLOT_DZ) / 2 - 2);
  scene.add(startLine);

  // station floor labels (big stencil type, nearest the camera and repeated far)
  BARRIERS.forEach((b, i) => {
    const t = stencilTexture(BARRIER_LABEL[b], SUB[b]);
    const mat = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
    const label = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.5), mat);
    label.rotation.set(-Math.PI / 2, 0, Math.PI);
    label.position.set(STATION_X[i] - 0.5, 0.01, -6.2);
    scene.add(label);
    const far = label.clone();
    far.position.z = MAX_SLOTS * SLOT_DZ + 2;
    scene.add(far);
    // station stripe across the whole width
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.5, MAX_SLOTS * SLOT_DZ + 12), new THREE.MeshBasicMaterial({ color: 0x2c2d33 }));
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(STATION_X[i], 0.004, (MAX_SLOTS * SLOT_DZ) / 2 - 2);
    scene.add(stripe);
  });

  // back wall with calibration checkerboards
  const wallZ = MAX_SLOTS * SLOT_DZ + 12;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(320, 14), new THREE.MeshStandardMaterial({ color: 0x1f2126, roughness: 1 }));
  wall.position.set(44, 7, wallZ);
  wall.rotation.y = Math.PI;
  scene.add(wall);
  const checker = new THREE.MeshStandardMaterial({ map: checkerTexture(8), roughness: 1 });
  for (let x = START_X; x < END_X + 10; x += 16) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), checker);
    panel.position.set(x, 4, wallZ - 0.05);
    panel.rotation.y = Math.PI;
    scene.add(panel);
  }
  // hazard skirting along the wall
  const skirt = new THREE.Mesh(new THREE.PlaneGeometry(320, 0.7), new THREE.MeshBasicMaterial({ map: hazardTexture([80, 1]) }));
  skirt.position.set(44, 0.35, wallZ - 0.06);
  skirt.rotation.y = Math.PI;
  scene.add(skirt);

  // overhead strip lights (emissive, cool)
  const stripGeo = new THREE.BoxGeometry(6, 0.12, 0.5);
  const stripMat = new THREE.MeshStandardMaterial({ color: 0xdfe8ff, emissive: 0xcfe0ff, emissiveIntensity: 2.6 });
  for (let x = START_X; x <= END_X; x += 11) {
    for (let z = -4; z < wallZ; z += 14) {
      const s = new THREE.Mesh(stripGeo, stripMat);
      s.position.set(x, 10.5, z);
      scene.add(s);
    }
  }
  // gantry beams
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.7, metalness: 0.5 });
  for (let x = START_X; x <= END_X; x += 22) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, wallZ + 12), beamMat);
    beam.position.set(x + 11, 12.2, wallZ / 2 - 6);
    scene.add(beam);
  }

  // lights: cool overhead + hemisphere fill, one shadow-casting key
  scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x0d0e11, 0.55));
  const key = new THREE.DirectionalLight(0xdbe6ff, 1.9);
  key.position.set(20, 30, -18);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 5;
  key.shadow.camera.far = 90;
  key.shadow.camera.left = -40;
  key.shadow.camera.right = 40;
  key.shadow.camera.top = 40;
  key.shadow.camera.bottom = -40;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);
  const rim = new THREE.DirectionalLight(0xe2412b, 0.35);
  rim.position.set(-30, 8, 40);
  scene.add(rim);

  return { key };
}
