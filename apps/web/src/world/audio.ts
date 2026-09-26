import * as THREE from 'three';
import { fx, type Biome, type FxEvent } from './fx';

// NaAP World v4 sound. WebAudio, created on the first user gesture (the "walk in" click), muted by a HUD toggle that
// persists in localStorage. The listener rides on the active camera (THREE.AudioListener), one-shots and engines are
// PannerNodes into it. Impacts, footsteps and UI cues are Kenney CC0 samples (public/audio/kenney); engines, screech,
// splash, sizzle, thunder and every biome ambience are synthesised (noise buffers + filters + envelopes). Any sample that
// fails to load or decode (e.g. old Safari and .ogg) falls back to a synthesised stand-in.

const BASE = '/audio/kenney/';
const SAMPLES = {
  metal: ['impactMetal_heavy_000', 'impactMetal_heavy_001', 'impactMetal_heavy_002'],
  crunch: ['explosionCrunch_000', 'explosionCrunch_002'],
  plate: ['impactPlate_heavy_000', 'impactPlate_heavy_001'],
  rock: ['impactMining_000', 'impactMining_001', 'impactMining_002', 'impactMining_003'],
  grass: ['footstep_grass_000', 'footstep_grass_001', 'footstep_grass_002', 'footstep_grass_003'],
  concrete: ['footstep_concrete_000', 'footstep_concrete_001', 'footstep_concrete_002', 'footstep_concrete_003'],
  soft: ['impactSoft_heavy_000', 'impactSoft_heavy_001'],
  boom: ['lowFrequency_explosion_000', 'lowFrequency_explosion_001'],
  fire: ['thrusterFire_000'],
  chime: ['confirmation_001'],
  ding: ['bong_001'],
  buzz: ['error_004'],
  tick: ['tick_001'],
  glass: ['glass_001'],
  card: ['bookFlip1'],
} as const;
type SampleKey = keyof typeof SAMPLES;
type NoiseKind = 'white' | 'pink' | 'brown' | 'crackle';

const MUTE_KEY = 'naap.world.muted';
const MAX_ENGINES = 8;
const ENGINE_RANGE = 220;
const EVENT_RANGE = 700;

interface EngineVoice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  filt: BiquadFilterNode;
  gain: GainNode;
  pan: PannerNode;
  last: number;
  dist: number;
}
interface Bed {
  biome: Biome;
  gain: GainNode;
  srcs: AudioScheduledSourceNode[];
  timers: number[];
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

export class WorldAudio {
  listener: THREE.AudioListener | null = null;
  ctx: AudioContext | null = null;
  private muted = false;
  private buffers = new Map<string, AudioBuffer>();
  private noiseBufs = new Map<NoiseKind, AudioBuffer>();
  private sfx!: GainNode;
  private amb!: GainNode;
  private voices = new Map<string, EngineVoice>();
  private bed: Bed | null = null;
  private biome: Biome = 'meadow';
  private subs = new Set<(muted: boolean) => void>();
  private lp = new THREE.Vector3();
  private loaded = 0;
  private failed = 0;
  private tick = 0;

  private camera: THREE.Object3D = new THREE.Object3D();

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
    fx.on((e) => this.onFx(e));
    (window as unknown as { __audio: WorldAudio }).__audio = this;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  /** The listener rides on this camera (the nav camera: walk, orbit and ride-along all use it). */
  attach(camera: THREE.Object3D) {
    this.camera = camera;
    if (this.listener) camera.add(this.listener);
  }

  /** Open the audio device at load: creating the AudioContext blocks the main thread for ~0.4 s, which used to land on
   *  the first drag. It stays suspended (and `ctx` unset, so nothing plays) until unlock(). */
  prepare() {
    if (this.listener) return;
    try {
      this.listener = new THREE.AudioListener();
    } catch (err) {
      console.warn('[audio] WebAudio unavailable', err);
      return;
    }
    this.camera.add(this.listener);
  }

  /** First user gesture: resume the AudioContext and build the graph. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.prepare();
    if (!this.listener) return;
    const ctx = (this.ctx = this.listener.context);
    void ctx.resume();
    this.listener.setMasterVolume(this.muted ? 0 : 1);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.listener.getInput());
    this.amb = ctx.createGain();
    this.amb.gain.value = 0.8;
    this.amb.connect(this.listener.getInput());
    this.makeNoise();
    this.startBed(this.biome);
    this.tick = window.setInterval(() => this.gcVoices(), 150);
    void this.loadSamples().then(() => console.info(`[audio] graph: ${this.summary()}`));
    console.info(`[audio] graph: ${this.summary()}`);
  }

  get isMuted() {
    return this.muted;
  }
  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (this.listener && this.ctx) {
      const g = this.listener.gain.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05);
    }
    if (m) for (const id of [...this.voices.keys()]) this.killVoice(id);
    for (const f of this.subs) f(m);
  }
  toggle() {
    this.unlock();
    this.setMuted(!this.muted);
    return this.muted;
  }
  onMute(f: (muted: boolean) => void) {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }

  /** One-line description of the live audio graph (logged after unlock, handy in devtools). */
  summary() {
    if (!this.ctx) return 'not started (waiting for a user gesture)';
    const nSamples = Object.values(SAMPLES).reduce((a, x) => a + x.length, 0);
    return (
      `ctx=${this.ctx.state} ${this.ctx.sampleRate}Hz · listener on camera · master=${this.muted ? 'muted' : 'on'} · ` +
      `sfx+amb gains → listener · bed=${this.bed?.biome ?? '-'} (${this.bed?.srcs.length ?? 0} srcs) · ` +
      `engines=${this.voices.size}/${MAX_ENGINES} · samples ${this.loaded}/${nSamples}${this.failed ? ` (${this.failed} synth fallback)` : ''}`
    );
  }

  /** Devtools: `__audio.test('crash-lava')` etc. */
  test(what: string) {
    this.unlock();
    const p = this.camera.getWorldPosition(new THREE.Vector3());
    const at = { x: p.x + 6, y: p.y, z: p.z };
    if (what.startsWith('crash-')) fx.emit({ t: 'crash', carId: 'test', kind: what.slice(6) as 'wall', ...at, lossUsd: 1 });
    else if (what === 'aeb') fx.emit({ t: 'aeb', carId: 'test', ...at });
    else if (what.startsWith('gate-')) fx.emit({ t: 'gate', state: what.slice(5) as 'open', ...at });
    else if (what === 'splash' || what === 'sizzle' || what === 'thunder') fx.emit({ t: what, ...at });
    else if (what === 'report') fx.emit({ t: 'report', carId: 'test' });
    else if (what === 'engine') for (let i = 0; i < 20; i++) setTimeout(() => fx.emit({ t: 'engine', carId: 'test', variant: 'bare', ...at, speed: i }), i * 100);
  }

  private async loadSamples() {
    const ctx = this.ctx!;
    const names = new Set(Object.values(SAMPLES).flat());
    await Promise.all(
      [...names].map(async (n) => {
        try {
          const r = await fetch(`${BASE}${n}.ogg`);
          if (!r.ok) throw new Error(String(r.status));
          const buf = await ctx.decodeAudioData(await r.arrayBuffer());
          this.buffers.set(n, buf);
          this.loaded++;
        } catch {
          this.failed++;
        }
      }),
    );
  }

  private makeNoise() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    for (const kind of ['white', 'pink', 'brown', 'crackle'] as NoiseKind[]) {
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'white') d[i] = w;
        else if (kind === 'pink') {
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.2965164;
          b2 = 0.57 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
        } else if (kind === 'brown') {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        } else d[i] = Math.random() < 0.0009 ? w * 2.2 : w * 0.04; // sparse pops over a faint hiss
      }
      this.noiseBufs.set(kind, buf);
    }
  }

  // ── building blocks ───────────────────────────────────────────────────────
  private far(x: number, y: number, z: number, range = EVENT_RANGE) {
    return this.distTo(x, y, z) > range;
  }
  private distTo(x: number, y: number, z: number) {
    const p = this.camera.getWorldPosition(this.lp);
    return Math.hypot(p.x - x, p.y - y, p.z - z);
  }

  /** A positional bus at (x, y, z); disconnects itself after `life` seconds. */
  private at(x: number, y: number, z: number, ref = 10, life = 6): AudioNode {
    const ctx = this.ctx!;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1;
    p.maxDistance = 3000;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    p.connect(this.sfx);
    window.setTimeout(() => p.disconnect(), life * 1000);
    return p;
  }

  private play(key: SampleKey, dest: AudioNode, o: { gain?: number; rate?: number; when?: number } = {}): boolean {
    const ctx = this.ctx!;
    const buf = this.buffers.get(pick(SAMPLES[key]));
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (o.rate ?? 1) * rnd(0.95, 1.05);
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g).connect(dest);
    src.start(ctx.currentTime + (o.when ?? 0));
    src.onended = () => g.disconnect();
    return true;
  }

  /** Enveloped filtered noise burst. */
  private noise(
    dest: AudioNode,
    o: { kind?: NoiseKind; when?: number; attack?: number; dur: number; gain: number; type?: BiquadFilterType; f0: number; f1?: number; q?: number },
  ) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.when ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBufs.get(o.kind ?? 'white')!;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'lowpass';
    f.Q.value = o.q ?? 0.7;
    f.frequency.setValueAtTime(o.f0, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    const g = ctx.createGain();
    const a = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + o.dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 2);
    src.stop(t + a + o.dur + 0.05);
    src.onended = () => g.disconnect();
  }

  /** Pitched tone with an envelope (and optional pitch glide). */
  private tone(dest: AudioNode, o: { type?: OscillatorType; f0: number; f1?: number; when?: number; attack?: number; dur: number; gain: number }) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.when ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    const g = ctx.createGain();
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + o.dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + a + o.dur + 0.05);
    osc.onended = () => g.disconnect();
  }

  private thud(dest: AudioNode, gain = 0.8, when = 0) {
    this.tone(dest, { f0: 140, f1: 45, dur: 0.35, gain, when });
    this.noise(dest, { dur: 0.25, gain: gain * 0.6, f0: 1800, f1: 300, when });
  }

  // ── fx bus ────────────────────────────────────────────────────────────────
  private onFx(e: FxEvent) {
    if (e.t === 'enter-biome') {
      this.biome = e.biome;
      if (this.ctx) this.startBed(e.biome);
      return;
    }
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    switch (e.t) {
      case 'engine':
        this.engine(e.carId + e.variant, e.x, e.y, e.z, e.speed);
        break;
      case 'crash':
        if (!this.far(e.x, e.y, e.z)) this.crash(e.kind, e.x, e.y, e.z);
        break;
      case 'aeb':
        if (!this.far(e.x, e.y, e.z, 400)) this.screech(this.at(e.x, e.y, e.z, 9, 3));
        break;
      case 'gate': {
        if (this.far(e.x, e.y, e.z, 300)) break;
        const d = this.at(e.x, e.y + 3, e.z, 8, 3);
        if (e.state === 'open') {
          if (!this.play('chime', d, { gain: 0.7 })) {
            this.tone(d, { f0: 988, dur: 0.5, gain: 0.25 });
            this.tone(d, { f0: 1319, dur: 0.7, gain: 0.22, when: 0.12 });
          }
        } else if (e.state === 'close') {
          if (!this.play('buzz', d, { gain: 0.7 })) this.tone(d, { type: 'square', f0: 140, dur: 0.45, gain: 0.12 });
        } else if (!this.play('tick', d, { gain: 0.8 })) this.tone(d, { type: 'triangle', f0: 1760, dur: 0.05, gain: 0.2 });
        break;
      }
      case 'splash':
        if (!this.far(e.x, e.y, e.z)) this.splash(this.at(e.x, e.y, e.z, 12, 5), false);
        break;
      case 'sizzle':
        if (!this.far(e.x, e.y, e.z)) this.sizzle(this.at(e.x, e.y, e.z, 10, 5), 2.2);
        break;
      case 'thunder':
        if (!this.far(e.x, e.y, e.z, 2000)) this.thunder(e.x, e.y, e.z);
        break;
      case 'report':
        if (!this.play('ding', this.sfx, { gain: 0.45 })) {
          this.tone(this.sfx, { f0: 1568, dur: 0.9, gain: 0.12 });
          this.tone(this.sfx, { f0: 2349, dur: 0.6, gain: 0.05, when: 0.01 });
        }
        if (!this.play('card', this.sfx, { gain: 0.55, when: 0.06 })) this.noise(this.sfx, { dur: 0.12, gain: 0.08, type: 'bandpass', f0: 3000, f1: 1500, when: 0.06 });
        break;
    }
  }

  // ── footsteps (nav) ───────────────────────────────────────────────────────
  footstep(surface: 'grass' | 'hard', sprint: boolean) {
    if (!this.ctx || this.muted) return;
    const gain = sprint ? 0.22 : 0.15;
    if (!this.play(surface === 'grass' ? 'grass' : 'concrete', this.sfx, { gain, rate: sprint ? 1.08 : 1 }))
      this.noise(this.sfx, { dur: 0.07, gain: gain * 0.5, type: 'bandpass', f0: surface === 'grass' ? 900 : 2200, q: 1.2 });
  }
  land(speed: number) {
    if (!this.ctx || this.muted) return;
    const g = Math.min(0.6, speed * 0.03);
    if (!this.play('soft', this.sfx, { gain: g })) this.thud(this.sfx, g * 0.5);
  }

  // ── engines ───────────────────────────────────────────────────────────────
  private engine(id: string, x: number, y: number, z: number, speed: number) {
    const d = this.distTo(x, y, z);
    let v = this.voices.get(id);
    if (!v) {
      if (d > ENGINE_RANGE) return;
      if (this.voices.size >= MAX_ENGINES) {
        // steal the farthest voice if this car is nearer
        let worst = '';
        let wd = -1;
        for (const [k, q] of this.voices)
          if (q.dist > wd) {
            wd = q.dist;
            worst = k;
          }
        if (wd <= d) return;
        this.killVoice(worst);
      }
      v = this.makeVoice(x, y, z);
      this.voices.set(id, v);
    }
    if (d > ENGINE_RANGE * 1.2) {
      this.killVoice(id);
      return;
    }
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const s = Math.max(0, speed);
    const f = 34 + s * 5.2;
    v.oscA.frequency.setTargetAtTime(f, t, 0.09);
    v.oscB.frequency.setTargetAtTime(f * 0.502, t, 0.09);
    v.filt.frequency.setTargetAtTime(260 + s * 75, t, 0.1);
    v.gain.gain.setTargetAtTime(Math.min(0.13, 0.03 + s * 0.0055), t, 0.12);
    v.pan.positionX.setTargetAtTime(x, t, 0.06);
    v.pan.positionY.setTargetAtTime(y + 0.6, t, 0.06);
    v.pan.positionZ.setTargetAtTime(z, t, 0.06);
    v.last = performance.now();
    v.dist = d;
  }

  private makeVoice(x: number, y: number, z: number): EngineVoice {
    const ctx = this.ctx!;
    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = 40;
    const oscB = ctx.createOscillator();
    oscB.type = 'square';
    oscB.frequency.value = 20;
    const mixB = ctx.createGain();
    mixB.gain.value = 0.55;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 300;
    filt.Q.value = 2.2;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = 6;
    pan.rolloffFactor = 1.3;
    pan.positionX.value = x;
    pan.positionY.value = y;
    pan.positionZ.value = z;
    oscA.connect(filt);
    oscB.connect(mixB).connect(filt);
    filt.connect(gain).connect(pan).connect(this.sfx);
    oscA.start();
    oscB.start();
    return { oscA, oscB, filt, gain, pan, last: performance.now(), dist: 0 };
  }

  private killVoice(id: string) {
    const v = this.voices.get(id);
    if (!v || !this.ctx) return;
    this.voices.delete(id);
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0.0001, t, 0.08);
    v.oscA.stop(t + 0.5);
    v.oscB.stop(t + 0.5);
    v.oscA.onended = () => v.pan.disconnect();
  }

  private gcVoices() {
    const now = performance.now();
    for (const [id, v] of this.voices) if (now - v.last > 700) this.killVoice(id);
  }

  // ── one-shots ─────────────────────────────────────────────────────────────
  private crash(kind: 'wall' | 'cliff-fall' | 'lava' | 'water' | 'rockfall', x: number, y: number, z: number) {
    const d = this.at(x, y + 0.5, z, 14, 7);
    switch (kind) {
      case 'wall':
        if (!this.play('metal', d, { gain: 1 })) this.thud(d, 0.9);
        if (!this.play('crunch', d, { gain: 0.75, when: 0.015 })) this.noise(d, { dur: 0.5, gain: 0.5, f0: 3500, f1: 500 });
        this.play('plate', d, { gain: 0.5, when: 0.12, rate: 1.2 });
        this.noise(d, { dur: 0.45, gain: 0.35, type: 'highpass', f0: 4000, when: 0.03 }); // glass + debris hiss
        for (let i = 0; i < 5; i++) this.tone(d, { type: 'triangle', f0: rnd(2500, 5200), dur: rnd(0.05, 0.12), gain: 0.03, when: 0.05 + rnd(0, 0.4) });
        break;
      case 'cliff-fall': {
        if (!this.play('metal', d, { gain: 0.9 })) this.thud(d, 0.8);
        this.play('crunch', d, { gain: 0.5, when: 0.02 });
        // tumbles down the cliff: impacts spaced out and getting duller
        for (let i = 0; i < 4; i++) if (!this.play(i % 2 ? 'metal' : 'plate', d, { gain: 0.85 - i * 0.15, rate: 0.9 - i * 0.06, when: 0.55 + i * 0.5 })) this.thud(d, 0.6 - i * 0.1, 0.55 + i * 0.5);
        // rockslide
        this.noise(d, { kind: 'brown', dur: 3.4, attack: 0.35, gain: 0.8, f0: 700, f1: 180, when: 0.3 });
        for (let i = 0; i < 9; i++) this.play('rock', d, { gain: rnd(0.25, 0.6), rate: rnd(0.7, 1.1), when: rnd(0.4, 3.2) });
        break;
      }
      case 'lava':
        if (!this.play('plate', d, { gain: 0.6 })) this.thud(d, 0.6);
        if (!this.play('boom', d, { gain: 1, when: 0.08, rate: 0.85 })) this.noise(d, { kind: 'brown', dur: 1.8, gain: 1, f0: 300, f1: 60, when: 0.08 });
        this.play('fire', d, { gain: 0.8, when: 0.12 });
        this.noise(d, { kind: 'brown', dur: 2.6, attack: 0.2, gain: 0.7, f0: 220, f1: 90, when: 0.1 }); // roar body
        this.sizzle(d, 3.6, 0.2);
        break;
      case 'water':
        this.play('plate', d, { gain: 0.35, rate: 0.8 });
        this.splash(d, true);
        break;
      case 'rockfall':
        this.noise(d, { kind: 'brown', dur: 2.8, attack: 0.25, gain: 0.9, f0: 500, f1: 120 });
        for (let i = 0; i < 10; i++) if (!this.play('rock', d, { gain: rnd(0.4, 0.9), rate: rnd(0.6, 1), when: rnd(0.05, 2.4) })) this.thud(d, 0.5, rnd(0.05, 2.4));
        break;
    }
  }

  private splash(d: AudioNode, big: boolean) {
    const g = big ? 1 : 0.6;
    this.tone(d, { f0: 160, f1: 45, dur: 0.3, gain: 0.5 * g }); // plunge
    this.noise(d, { dur: big ? 1.1 : 0.7, gain: 0.7 * g, type: 'bandpass', f0: 2600, f1: 420, q: 0.8, attack: 0.01 });
    this.noise(d, { dur: 0.9, gain: 0.25 * g, type: 'highpass', f0: 5000, when: 0.08, attack: 0.02 }); // spray
    this.play('soft', d, { gain: 0.5 * g, rate: 0.7 });
    // bubbles as it sinks
    for (let i = 0; i < (big ? 14 : 6); i++) {
      const f = rnd(280, 900);
      this.tone(d, { f0: f, f1: f * rnd(1.6, 2.4), dur: rnd(0.05, 0.11), gain: 0.05, when: 0.6 + i * rnd(0.08, 0.22) });
    }
  }

  private sizzle(d: AudioNode, dur: number, when = 0) {
    this.noise(d, { kind: 'crackle', dur, attack: 0.08, gain: 0.9, type: 'highpass', f0: 2200, when });
    this.noise(d, { dur, attack: 0.1, gain: 0.18, type: 'bandpass', f0: 6500, f1: 4000, q: 0.6, when });
  }

  private screech(d: AudioNode) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = 0.95;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
    g.gain.setValueAtTime(0.22, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2300;
    bp.Q.value = 5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 27;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 55;
    lfo.connect(lfoG);
    for (const m of [1, 1.51]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(1150 * m, t);
      o.frequency.exponentialRampToValueAtTime(760 * m, t + dur);
      lfoG.connect(o.frequency);
      o.connect(bp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
    bp.connect(g).connect(d);
    this.noise(d, { dur: dur * 0.9, gain: 0.18, type: 'bandpass', f0: 3200, f1: 1800, q: 1.5 });
    window.setTimeout(() => g.disconnect(), (dur + 0.3) * 1000);
  }

  private thunder(x: number, y: number, z: number) {
    const d = this.at(x, y, z, 90, 8);
    const delay = Math.min(1.5, this.distTo(x, y, z) / 340); // light first, sound later
    this.noise(d, { dur: 0.18, gain: 0.7, type: 'highpass', f0: 1400, when: delay });
    this.noise(d, { kind: 'brown', dur: 4.8, attack: 0.12, gain: 1.4, f0: 320, f1: 90, when: delay + 0.03 });
    this.noise(d, { kind: 'brown', dur: 2.2, attack: 0.4, gain: 0.6, f0: 160, when: delay + 1.1 });
    this.play('boom', d, { gain: 0.8, rate: 0.62, when: delay + 0.05 });
  }

  // ── ambience per biome ────────────────────────────────────────────────────
  private loopNoise(bed: Bed, kind: NoiseKind, type: BiquadFilterType, freq: number, q: number, gain: number, lfo?: { rate: number; freq?: number; gain?: number }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBufs.get(kind)!;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(bed.gain);
    src.start(0, Math.random() * 2);
    bed.srcs.push(src);
    if (lfo) {
      const o = ctx.createOscillator();
      o.frequency.value = lfo.rate;
      if (lfo.freq) {
        const d = ctx.createGain();
        d.gain.value = lfo.freq;
        o.connect(d).connect(f.frequency);
      }
      if (lfo.gain) {
        const d = ctx.createGain();
        d.gain.value = lfo.gain;
        o.connect(d).connect(g.gain);
      }
      o.start();
      bed.srcs.push(o);
    }
  }

  private every(bed: Bed, min: number, max: number, fn: (dest: AudioNode) => void) {
    const loop = () => {
      if (this.bed !== bed) return;
      if (!this.muted) {
        const pan = this.ctx!.createStereoPanner();
        pan.pan.value = rnd(-0.85, 0.85);
        pan.connect(bed.gain);
        fn(pan);
        window.setTimeout(() => pan.disconnect(), 4000);
      }
      bed.timers.push(window.setTimeout(loop, rnd(min, max) * 1000));
    };
    bed.timers.push(window.setTimeout(loop, rnd(min, max) * 500));
  }

  private startBed(biome: Biome) {
    const ctx = this.ctx;
    if (!ctx || this.bed?.biome === biome) return;
    const old = this.bed;
    const t = ctx.currentTime;
    if (old) {
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(0, t, 0.8);
      for (const id of old.timers) window.clearTimeout(id);
      window.setTimeout(() => {
        for (const s of old.srcs)
          try {
            s.stop();
          } catch {
            /* already stopped */
          }
        old.gain.disconnect();
      }, 4000);
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(1, t, 0.8);
    gain.connect(this.amb);
    const bed: Bed = { biome, gain, srcs: [], timers: [] };
    this.bed = bed;
    switch (biome) {
      case 'meadow':
        this.loopNoise(bed, 'brown', 'lowpass', 520, 0.5, 0.07, { rate: 0.07, gain: 0.035 });
        this.every(bed, 0.5, 2.4, (d) => this.bird(d));
        break;
      case 'storm-ridge':
        this.loopNoise(bed, 'pink', 'bandpass', 480, 0.8, 0.2, { rate: 0.13, freq: 260, gain: 0.08 });
        this.loopNoise(bed, 'white', 'bandpass', 5200, 0.35, 0.075); // rain
        this.loopNoise(bed, 'brown', 'lowpass', 180, 0.5, 0.08); // distant rumble bed
        this.every(bed, 0.05, 0.25, (d) => this.noise(d, { dur: 0.012, gain: rnd(0.01, 0.04), type: 'highpass', f0: 3000 })); // drops
        break;
      case 'caldera':
        this.loopNoise(bed, 'brown', 'lowpass', 110, 0.7, 0.5, { rate: 0.05, gain: 0.15 });
        this.loopNoise(bed, 'crackle', 'highpass', 1800, 0.5, 0.35);
        this.every(bed, 0.15, 0.7, (d) => {
          const f = rnd(60, 150);
          this.tone(d, { f0: f, f1: f * 1.8, dur: rnd(0.08, 0.16), gain: 0.07 }); // lava bubble
        });
        break;
      case 'river-canyon':
        this.loopNoise(bed, 'pink', 'bandpass', 720, 0.5, 0.26, { rate: 0.11, freq: 120, gain: 0.04 });
        this.loopNoise(bed, 'brown', 'lowpass', 320, 0.5, 0.14);
        this.loopNoise(bed, 'white', 'highpass', 6000, 0.5, 0.012);
        this.loopNoise(bed, 'pink', 'bandpass', 900, 3, 0.03, { rate: 0.06, freq: 200 }); // canyon wind
        break;
      case 'rockfall-pass':
        this.loopNoise(bed, 'pink', 'bandpass', 620, 4, 0.14, { rate: 0.09, freq: 220, gain: 0.05 }); // whistling canyon wind
        this.loopNoise(bed, 'brown', 'lowpass', 260, 0.5, 0.07);
        this.every(bed, 2, 6, (d) => {
          for (let i = 0; i < 3; i++) this.play('rock', d, { gain: rnd(0.05, 0.12), rate: rnd(1.2, 1.7), when: i * rnd(0.08, 0.25) });
        });
        break;
    }
  }

  private bird(d: AudioNode) {
    const base = rnd(2400, 4200);
    const n = Math.floor(rnd(2, 6));
    let w = 0;
    for (let i = 0; i < n; i++) {
      const dur = rnd(0.05, 0.12);
      const up = Math.random() < 0.6;
      this.tone(d, { f0: base * (up ? 0.85 : 1.15), f1: base * (up ? 1.2 : 0.8), dur, gain: rnd(0.02, 0.045), when: w });
      w += dur + rnd(0.03, 0.09);
    }
  }
}
