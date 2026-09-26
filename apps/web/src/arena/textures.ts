import * as THREE from 'three';
import { PALETTE } from '../types';

const DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif';
const MONO = '"JetBrains Mono", Menlo, monospace';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function tex(c: HTMLCanvasElement, opts: { repeat?: [number, number]; nearest?: boolean } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...opts.repeat);
  }
  if (opts.nearest) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapNearestFilter;
  }
  return t;
}

/** Yellow/black diagonal hazard stripes. */
export function hazardTexture(repeat: [number, number] = [1, 1]) {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#111';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = PALETTE.yellow;
  for (let i = -128; i < 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 128);
    g.lineTo(i + 128, 0);
    g.lineTo(i + 160, 0);
    g.lineTo(i + 32, 128);
    g.closePath();
    g.fill();
  }
  return tex(c, { repeat });
}

/** Calibration checkerboard (white/black). */
export function checkerTexture(n = 8) {
  const [c, g] = canvas(256, 256);
  const s = 256 / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#f2f2ef' : '#141519';
      g.fillRect(x * s, y * s, s, s);
    }
  return tex(c, { nearest: true });
}

/** Pale grey epoxy hall floor with faint grain and scuffs (NCAP halls are light, not dark). */
export function floorTexture() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#b4b6b3';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 12000; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${Math.random() * 0.08})` : `rgba(0,0,0,${Math.random() * 0.07})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = 'rgba(40,40,40,0.05)';
  g.lineWidth = 6;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    const y = Math.random() * 512;
    g.moveTo(0, y);
    g.bezierCurveTo(170, y + 20, 340, y - 20, 512, y + 5);
    g.stroke();
  }
  return tex(c, { repeat: [48, 24] });
}

/** Metre ticks along a lane edge (repeat once per metre). */
export function tickTexture() {
  const [c, g] = canvas(64, 64);
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(30,30,32,0.55)';
  g.fillRect(0, 0, 4, 64);
  g.fillRect(32, 22, 3, 20);
  return tex(c, { repeat: [1, 1] });
}

/** Deformable aluminium honeycomb face: silver with a slight yellow cast and a hex grid. */
export function honeycombTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#d9d3b6';
  g.fillRect(0, 0, 256, 256);
  const r = 9;
  const h = r * Math.sqrt(3);
  g.strokeStyle = 'rgba(70,64,40,0.55)';
  g.lineWidth = 1.4;
  for (let row = -1; row < 256 / h + 2; row++) {
    for (let col = -1; col < 256 / (1.5 * r) + 2; col++) {
      const cx = col * 1.5 * r;
      const cy = row * h + (col % 2 ? h / 2 : 0);
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
    }
  }
  const grad = g.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, 'rgba(255,255,255,0.18)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return tex(c, { repeat: [2, 2] });
}

/** Yellow/black measuring-tape stripe that runs along the flank of every test car. */
export function tapeTexture() {
  const [c, g] = canvas(256, 32);
  g.fillStyle = PALETTE.yellow;
  g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#111';
  for (let x = 0; x < 256; x += 32) g.fillRect(x, 0, 16, 32);
  g.fillStyle = '#fff';
  for (let x = 8; x < 256; x += 32) g.fillRect(x - 1, 10, 2, 12);
  return tex(c, { repeat: [1, 1] });
}

/** Crash-test roundel: yellow/black quarters on a white ring. */
export function roundelTexture() {
  const [c, g] = canvas(128, 128);
  g.clearRect(0, 0, 128, 128);
  g.translate(64, 64);
  g.fillStyle = '#f2efe8';
  g.beginPath();
  g.arc(0, 0, 62, 0, Math.PI * 2);
  g.fill();
  for (let q = 0; q < 4; q++) {
    g.fillStyle = q % 2 ? '#111' : PALETTE.yellow;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 54, (q * Math.PI) / 2, ((q + 1) * Math.PI) / 2);
    g.closePath();
    g.fill();
  }
  return tex(c);
}

/** Vermilion 関 roof badge. */
export function sekiBadgeTexture() {
  const [c, g] = canvas(128, 128);
  g.fillStyle = PALETTE.vermilion;
  g.beginPath();
  g.roundRect(4, 4, 120, 120, 14);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `700 92px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('関', 64, 70);
  return tex(c);
}

/** Shattered windscreen: transparent with white radial cracks. */
export function crackTexture() {
  const [c, g] = canvas(256, 128);
  g.clearRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(210,225,235,0.28)';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 1.5;
  for (const [cx, cy] of [
    [80, 70],
    [190, 55],
  ]) {
    for (let k = 0; k < 16; k++) {
      const a = (Math.PI * 2 * k) / 16 + Math.random() * 0.3;
      g.beginPath();
      g.moveTo(cx, cy);
      let x = cx;
      let y = cy;
      for (let s = 0; s < 5; s++) {
        x += Math.cos(a) * (12 + Math.random() * 14);
        y += Math.sin(a) * (10 + Math.random() * 10);
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let ring = 12; ring < 70; ring += 14) {
      g.beginPath();
      g.arc(cx, cy, ring + Math.random() * 6, 0, Math.PI * 2);
      g.stroke();
    }
  }
  return tex(c);
}

/** Floor stencil label for a barrier station (dark ink on the pale floor). */
export function stencilTexture(text: string, sub: string) {
  const [c, g] = canvas(1024, 384);
  g.clearRect(0, 0, 1024, 384);
  g.fillStyle = '#2a2c31';
  g.font = `800 190px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.globalAlpha = 0.85;
  g.fillText(text, 512, 170);
  g.globalCompositeOperation = 'destination-out';
  for (let x = 40; x < 1024; x += 118) g.fillRect(x, 60, 9, 230);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 0.8;
  g.fillStyle = '#4a4c52';
  g.font = `500 44px ${MONO}`;
  g.fillText(sub, 512, 322);
  return tex(c);
}

/** Lane label decal: `BARE · NO PROTECTION` / `SEKISHO · AIRBAG`. */
export function laneLabelTexture(text: string, tone: 'bare' | 'sekisho') {
  const [c, g] = canvas(1024, 160);
  g.clearRect(0, 0, 1024, 160);
  g.fillStyle = tone === 'bare' ? '#2a2c31' : PALETTE.vermilion;
  g.fillRect(0, 20, 22, 120);
  g.font = `800 88px ${DISPLAY}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.globalAlpha = 0.92;
  g.fillText(text, 48, 84);
  return tex(c);
}

/** Start-line bracket sign: `<car> — same agent, two runs`. */
export function bracketTexture(name: string, color: string) {
  const [c, g] = canvas(768, 256);
  g.fillStyle = '#f2efe8';
  g.beginPath();
  g.roundRect(0, 0, 768, 256, 10);
  g.fill();
  g.fillStyle = color;
  g.fillRect(0, 0, 26, 256);
  g.strokeStyle = '#2a2c31';
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(90, 40);
  g.lineTo(60, 40);
  g.lineTo(60, 216);
  g.lineTo(90, 216);
  g.stroke();
  g.fillStyle = '#15161a';
  g.font = `800 96px ${DISPLAY}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(name, 112, 86);
  g.fillStyle = '#5a5850';
  g.font = `500 38px ${MONO}`;
  g.fillText('same agent · two runs', 114, 178);
  return tex(c);
}

/** Name billboard above a car. */
export function billboardTexture(name: string, sub: string, color: string) {
  const [c, g] = canvas(512, 160);
  g.clearRect(0, 0, 512, 160);
  g.fillStyle = 'rgba(21,22,26,0.88)';
  g.beginPath();
  g.roundRect(0, 0, 512, 128, 12);
  g.fill();
  g.fillStyle = color;
  g.fillRect(0, 0, 14, 128);
  g.fillStyle = '#f2efe8';
  g.font = `700 72px ${DISPLAY}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(name, 40, 54);
  g.fillStyle = '#c9c7bf';
  g.font = `500 30px ${MONO}`;
  g.fillText(sub, 42, 104);
  g.fillStyle = 'rgba(21,22,26,0.88)';
  g.beginPath();
  g.moveTo(236, 128);
  g.lineTo(276, 128);
  g.lineTo(256, 156);
  g.fill();
  return tex(c);
}

/** Wooden gate plaque with the refusal reason and Control chips. */
export function plaqueTexture(reason: string, chips: string[], tone: 'vermilion' | 'green' | 'amber' | 'wood' = 'wood') {
  const W = 768;
  const H = 320;
  const [c, g] = canvas(W, H);
  const bg = tone === 'green' ? '#1f6b4c' : tone === 'amber' ? '#8a5a12' : tone === 'vermilion' ? '#7a2417' : '#c9a066';
  const ink = tone === 'wood' ? '#1a120a' : '#f2efe8';
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = tone === 'wood' ? 'rgba(80,45,10,0.18)' : 'rgba(0,0,0,0.18)';
  g.lineWidth = 3;
  for (let i = 0; i < 18; i++) {
    g.beginPath();
    const y = 10 + i * 18 + Math.sin(i) * 6;
    g.moveTo(0, y);
    g.bezierCurveTo(W * 0.3, y + 8, W * 0.6, y - 8, W, y + 4);
    g.stroke();
  }
  g.strokeStyle = tone === 'wood' ? PALETTE.vermilion : 'rgba(255,255,255,0.35)';
  g.lineWidth = 10;
  g.strokeRect(5, 5, W - 10, H - 10);
  g.fillStyle = ink;
  g.font = `700 46px ${DISPLAY}`;
  g.textBaseline = 'top';
  const words = reason.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width > W - 64 && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 3);
  if (lines.length > 3) shown[2] = shown[2].replace(/\s?\S*$/, '…');
  shown.forEach((l, i) => g.fillText(l, 32, 30 + i * 52));
  let x = 32;
  const y = H - 84;
  g.font = `700 26px ${MONO}`;
  for (const chip of chips.slice(0, 5)) {
    const w = g.measureText(chip).width + 28;
    if (x + w > W - 32) break;
    g.fillStyle = tone === 'wood' ? PALETTE.vermilion : 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.roundRect(x, y, w, 48, 8);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(chip, x + 14, y + 11);
    x += w + 12;
  }
  return tex(c);
}

/** Amber countdown ring; progress 0..1 (remaining). */
export function drawRing(c: HTMLCanvasElement, progress: number, color = PALETTE.amber) {
  const g = c.getContext('2d')!;
  const S = c.width;
  g.clearRect(0, 0, S, S);
  g.lineCap = 'round';
  g.lineWidth = S * 0.09;
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.4, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = color;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, progress)));
  g.stroke();
  g.fillStyle = color;
  g.font = `800 ${S * 0.3}px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('WORLD', S / 2, S / 2 + S * 0.02);
}

/** Radial glow sprite texture (white; tint via material color). */
export function glowTexture() {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Soft puff for tyre smoke and coolant mist. */
export function smokeTexture() {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Hall signage: NaAP wordmark banner on the back wall (never the real Euro NCAP mark). */
export function signTexture(title: string, sub: string) {
  const [c, g] = canvas(1024, 256);
  g.fillStyle = '#15161a';
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = PALETTE.yellow;
  g.fillRect(0, 0, 1024, 18);
  g.fillRect(0, 238, 1024, 18);
  g.fillStyle = '#f2efe8';
  g.font = `800 150px ${DISPLAY}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(title, 48, 118);
  g.fillStyle = PALETTE.yellow;
  g.font = `600 40px ${DISPLAY}`;
  g.fillText(sub, 420, 100);
  g.fillStyle = '#9a9890';
  g.font = `500 26px ${MONO}`;
  g.fillText('crash-test hall · 5 barriers · bare vs sekisho', 422, 150);
  return tex(c);
}

export { DISPLAY, MONO };
