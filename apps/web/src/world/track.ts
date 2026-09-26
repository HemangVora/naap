import * as THREE from 'three';
import type { BarrierId, TrackSpec } from '../types';
import { ATTACK_TYPES } from '../types';
import { obstacleTitle } from '../incidents';
import { Barrier, Gate, SoftTarget } from '../arena/fixtures';
import { asphaltTexture, dashTexture, drawCounter, gantryTexture, kerbTexture, roadNameTexture, grassTexture } from './tex';
import { buildProp } from './props';
import { DEATH_FOR } from './biomes/geo';
import { LANE_DZ, MAX_SLOTS, PROP_Z, RUNUP_X, START_X, endX, laneZ, plotOrigin, slotZ, stationX } from './layout';

const Mat = {
  asphalt: null as THREE.MeshStandardMaterial | null,
  line: new THREE.MeshBasicMaterial({ color: 0xf2efe8, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
  yellowLine: new THREE.MeshBasicMaterial({ color: 0xf5c400, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
  dash: null as THREE.MeshBasicMaterial | null,
  kerb: null as THREE.MeshStandardMaterial | null,
  verge: null as THREE.MeshStandardMaterial | null,
  steel: new THREE.MeshStandardMaterial({ color: 0x8f9298, roughness: 0.45, metalness: 0.6 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.8 }),
  flagY: new THREE.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.8, side: THREE.DoubleSide }),
  flagV: new THREE.MeshStandardMaterial({ color: 0xe2412b, roughness: 0.8, side: THREE.DoubleSide }),
};
const asphaltMat = () =>
  (Mat.asphalt ??= new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
const kerbMat = () => (Mat.kerb ??= new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.7 }));
const vergeMat = () => (Mat.verge ??= new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
const dashMat = () => (Mat.dash ??= new THREE.MeshBasicMaterial({ map: dashTexture(), transparent: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));

function flat(w: number, d: number, mat: THREE.Material, x: number, z: number, y = 0, repeat?: [number, number]) {
  const geo = new THREE.PlaneGeometry(w, d);
  if (repeat) {
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * repeat[0], uv.getY(i) * repeat[1]);
  }
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

export interface Slot {
  index: number;
  gates: Gate[]; // sekisho lane, per step
  targets: (SoftTarget | null)[];
  bare: (Barrier | Gate)[]; // bare lane, per step
  road: THREE.Object3D[];
  owner?: string; // car id currently using the slot
}

interface Counter {
  type: BarrierId;
  /** Sign label: the preset name, or a custom incident's title. */
  title: string;
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  last: string;
  step: number;
}

/** One track = one road on its plot: run-up with the painted name, gantry sign, lane pairs (slots), obstacles with props + counters. */
export class TrackView {
  group = new THREE.Group();
  slots: Slot[] = [];
  n: number;
  /** meshes that select this track on click */
  pickables: THREE.Object3D[] = [];
  updatables: { update(dt: number): void }[] = [];
  private counters: Counter[] = [];
  origin: { x: number; z: number };
  createdAt = performance.now();
  lastActivity = 0;

  constructor(public spec: TrackSpec, public plot: number) {
    this.n = Math.max(1, spec.obstacles.length);
    const o = plotOrigin(plot, this.n);
    this.origin = { x: o.x, z: o.z };
    this.group.position.set(o.x, 0, o.z);
    this.group.userData.trackId = spec.id;
    this.buildStatic();
    this.addSlot();
  }

  stationX(step: number) {
    return stationX(Math.max(0, Math.min(this.n - 1, step)), this.n);
  }
  get endX() {
    return endX(this.n);
  }
  type(step: number): BarrierId {
    return this.spec.obstacles[Math.max(0, Math.min(this.n - 1, step))]?.type ?? 'legit';
  }

  /** World-space bounds of the road (for framing and the mini-map). */
  bounds(target = new THREE.Box3()) {
    const zMax = slotZ(Math.max(0, this.slots.length - 1)) + 3;
    target.min.set(this.origin.x + RUNUP_X, 0, this.origin.z + PROP_Z - 3);
    target.max.set(this.origin.x + this.endX + 6, 10, this.origin.z + zMax);
    return target;
  }

  private buildStatic() {
    const g = this.group;
    const x0 = RUNUP_X;
    const x1 = this.endX + 6;
    const len = x1 - x0;
    const cx = (x0 + x1) / 2;
    // v4: the plot's biome terrain (biomes/terrain.ts) replaces the flat far verge
    void vergeMat;
    void len;
    void cx;
    // gantry sign over the run-up, spanning slot 0
    const gx = START_X - 6;
    const zA = 2.6;
    const zB = -LANE_DZ - 2.6;
    for (const z of [zA, zB]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7.2, 0.4), Mat.steel);
      p.position.set(gx, 3.6, z);
      p.castShadow = true;
      g.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, zA - zB + 0.6), Mat.steel);
    beam.position.set(gx, 7.0, (zA + zB) / 2);
    g.add(beam);
    const panelTex = gantryTexture(this.spec.name, this.spec.author, this.n, !!this.spec.isDefault);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 2.4), new THREE.MeshBasicMaterial({ map: panelTex, toneMapped: false, side: THREE.DoubleSide }));
    // faces the oncoming cars (−x), turned a little toward the grandstand side so it reads from the default view
    panel.position.set(gx - 0.3, 8.6, (zA + zB) / 2);
    panel.rotation.y = -Math.PI / 2 + 0.55;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.6, 9.8), Mat.dark);
    back.position.copy(panel.position);
    back.rotation.y = panel.rotation.y + Math.PI / 2;
    back.position.x += 0.15;
    g.add(back, panel);
    // painted name on the run-up (reads from above)
    const name = flat(24, 7.5, new THREE.MeshBasicMaterial({ map: roadNameTexture(this.spec.name, this.spec.author), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), RUNUP_X + 15, -LANE_DZ / 2, 0.05);
    g.add(name);
    this.pickables.push(panel, back, name, beam);
    // flags at the start
    for (const [z, mat] of [
      [zA + 2.2, Mat.flagY],
      [zB - 2.2, Mat.flagV],
    ] as const) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 9, 6), Mat.steel);
      pole.position.set(gx + 4, 4.5, z);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4, 6, 1), mat);
      flag.position.set(gx + 5.25, 8.2, z);
      flag.userData.wave = Math.random() * 6;
      g.add(pole, flag);
      this.flags.push(flag);
    }
    // props + counters, one per obstacle
    this.spec.obstacles.forEach((ob, i) => {
      const p = buildProp(ob);
      p.position.set(this.stationX(i) + 2, 0, PROP_Z);
      g.add(p);
      this.props[i] = p;
      this.pickables.push(p);
      if (ATTACK_TYPES.includes(ob.type) || ob.type === 'over-limit') {
        const c = document.createElement('canvas');
        c.width = 512;
        c.height = 136;
        const title = obstacleTitle(ob);
        drawCounter(c, title, 0, 0);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
        sprite.scale.set(7.2, 1.9, 1);
        sprite.center.set(0.5, 0);
        sprite.position.set(this.stationX(i) + 2, ob.type === 'freysa' ? 12.4 : 10.4, PROP_Z);
        sprite.renderOrder = 8;
        g.add(sprite);
        this.counters.push({ type: ob.type, title, sprite, canvas: c, tex, last: '', step: i });
      }
    });
  }
  private flags: THREE.Mesh[] = [];
  props: THREE.Object3D[] = [];

  /** v4: move each obstacle's prop (and its counter) to where its biome wants it (a spire, an island, a canyon wall). */
  applyBiome(spot: (i: number) => { x: number; y: number; z: number; rotY: number } | null) {
    this.props.forEach((p, i) => {
      const s = spot(i);
      if (!s) return;
      p.position.set(s.x, s.y, s.z);
      p.rotation.y = s.rotY;
      const c = this.counters.find((k) => k.step === i);
      if (c) c.sprite.position.set(s.x, s.y + (this.spec.obstacles[i].type === 'freysa' ? 12.4 : 10.4), s.z);
    });
    for (const c of this.counters) if (c.type === 'over-limit') c.sprite.position.y = Math.max(c.sprite.position.y, 19);
  }

  /** Update the floating "fooled a/b" counters from Stats (by obstacle type). */
  setCounters(by: Map<BarrierId, { attempts: number; fooled: number }>) {
    for (const c of this.counters) {
      const a = by.get(c.type) ?? { attempts: 0, fooled: 0 };
      const key = `${a.fooled}/${a.attempts}`;
      if (key === c.last) continue;
      c.last = key;
      drawCounter(c.canvas, c.title, a.fooled, a.attempts);
      c.tex.needsUpdate = true;
    }
  }

  /** Lazily add lane pair k (road surface + fixtures). */
  addSlot(): Slot {
    const k = this.slots.length;
    const g = this.group;
    const z0 = slotZ(k);
    const x0 = RUNUP_X;
    const x1 = this.endX + 6;
    const len = x1 - x0;
    const cx = (x0 + x1) / 2;
    const road: THREE.Object3D[] = [];
    const add = (o: THREE.Object3D) => {
      g.add(o);
      road.push(o);
    };
    // asphalt for both lanes (+ the gap to the previous slot)
    const zTop = z0 + 2.2;
    const zBot = k === 0 ? z0 - LANE_DZ - 2.2 : slotZ(k - 1) + 2.2;
    add(flat(len, zTop - zBot, asphaltMat(), cx, (zTop + zBot) / 2, 0.03, [len / 8, (zTop - zBot) / 8]));
    // lane edge lines, dashed centre line, start + finish lines
    for (const z of [z0 + 1.8, z0 - LANE_DZ - 1.8]) add(flat(len - 2, 0.14, Mat.line, cx, z, 0.045));
    add(flat(len - 2, 0.14, dashMat(), cx, z0 - LANE_DZ / 2, 0.045, [len / 6, 1]));
    add(flat(0.5, LANE_DZ + 3.6, Mat.line, START_X + 1, z0 - LANE_DZ / 2, 0.046));
    add(flat(0.5, LANE_DZ + 3.6, Mat.yellowLine, this.endX - 2, z0 - LANE_DZ / 2, 0.046));
    // kerbs on the outer edges
    const kerbGeo = new THREE.BoxGeometry(len, 0.14, 0.45);
    const uv = kerbGeo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / 2));
    kerbMat().map!.wrapS = THREE.RepeatWrapping;
    if (k === 0) {
      const kb = new THREE.Mesh(kerbGeo, kerbMat());
      kb.position.set(cx, 0.07, z0 - LANE_DZ - 2.4);
      kb.receiveShadow = true;
      add(kb);
    }
    const kt = new THREE.Mesh(kerbGeo, kerbMat());
    kt.position.set(cx, 0.07, zTop + 0.2);
    kt.receiveShadow = true;
    add(kt);
    if (k > 0) {
      // the previous slot's top kerb becomes a painted separator
      const prev = this.slots[k - 1];
      for (const o of prev.road) if (o instanceof THREE.Mesh && o.geometry instanceof THREE.BoxGeometry && Math.abs(o.position.z - (slotZ(k - 1) + 2.4)) < 0.01) o.visible = false;
    }

    const slot: Slot = { index: k, gates: [], targets: [], bare: [], road };
    this.spec.obstacles.forEach((ob, i) => {
      const x = this.stationX(i);
      const attack = ATTACK_TYPES.includes(ob.type);
      const gate = new Gate(x, laneZ(k, 'airbag'), attack ? 'sekisho' : 'toll');
      g.add(gate.group);
      slot.gates[i] = gate;
      this.updatables.push(gate);
      if (attack) {
        const t = new SoftTarget(x + 3.6, laneZ(k, 'airbag'));
        g.add(t.group);
        slot.targets[i] = t;
        this.updatables.push(t);
        const b = new Barrier(x, laneZ(k, 'bare'));
        // v4: the bare lane's hazard is the biome itself (cliff / lava ramp / broken bridge), not a crash wall
        if (DEATH_FOR[ob.type]) b.group.visible = false;
        g.add(b.group);
        slot.bare[i] = b;
        this.updatables.push(b);
      } else {
        slot.targets[i] = null;
        const toll = new Gate(x, laneZ(k, 'bare'), 'toll');
        g.add(toll.group);
        slot.bare[i] = toll;
        this.updatables.push(toll);
      }
    });
    this.slots.push(slot);
    return slot;
  }

  /** A free lane pair for a new car (adds one up to MAX_SLOTS; else the one whose car left longest ago). */
  claimSlot(carId: string): Slot | null {
    const free = this.slots.find((s) => !s.owner);
    const slot = free ?? (this.slots.length < MAX_SLOTS ? this.addSlot() : null);
    if (slot) slot.owner = carId;
    return slot;
  }

  releaseSlot(slot: Slot) {
    slot.owner = undefined;
    for (const g of slot.gates) g.setState('idle');
    for (const t of slot.targets) t?.raise(false);
    for (const f of slot.bare) {
      if (f instanceof Barrier) {
        f.raise(false);
        f.setDent(0);
      } else f.setState('idle');
    }
  }

  update(dt: number, t: number, camDist = 100) {
    for (const u of this.updatables) u.update(dt);
    const k = Math.min(6.5, Math.max(2.2, camDist * 0.016));
    for (const c of this.counters) {
      c.sprite.scale.set(k * 3.8, k, 1);
      // far away only the counters with a score stay up (keeps the overview readable)
      c.sprite.visible = camDist < 170 || !c.last.endsWith('/0');
    }
    for (const f of this.flags) {
      const w = f.userData.wave as number;
      f.rotation.y = Math.sin(t * 2.2 + w) * 0.25;
    }
  }
}
