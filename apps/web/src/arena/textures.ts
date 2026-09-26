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
  t.anisotropy = 4;
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

/** Calibration checkerboard (white/black) used on wall panels. */
export function checkerTexture(n = 8) {
  const [c, g] = canvas(256, 256);
  const s = 256 / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#d8d5cc' : '#141519';
      g.fillRect(x * s, y * s, s, s);
    }
  return tex(c, { nearest: true });
}

/** Dark concrete floor with faint grid + tyre scuffs. */
export function floorTexture() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#17181c';
  g.fillRect(0, 0, 512, 512);
  // grain
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 2;
  for (let i = 0; i <= 512; i += 128) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 512);
    g.moveTo(0, i);
    g.lineTo(512, i);
    g.stroke();
  }
  return tex(c, { repeat: [40, 20] });
}

/** Crash-test roundel: yellow/black quarters. */
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

/** Floor stencil label for a barrier station. */
export function stencilTexture(text: string, sub: string) {
  const [c, g] = canvas(1024, 384);
  g.clearRect(0, 0, 1024, 384);
  g.fillStyle = PALETTE.yellow;
  g.font = `800 190px ${DISPLAY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.globalAlpha = 0.82;
  g.fillText(text, 512, 170);
  // stencil bridges: a few dark cuts across the glyphs
  g.globalCompositeOperation = 'destination-out';
  for (let x = 40; x < 1024; x += 118) g.fillRect(x, 60, 9, 230);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 0.6;
  g.fillStyle = '#d8d5cc';
  g.font = `500 44px ${MONO}`;
  g.fillText(sub, 512, 322);
  return tex(c);
}

/** Name billboard above a car. Returns texture + aspect. */
export function billboardTexture(name: string, sub: string, color: string) {
  const [c, g] = canvas(512, 160);
  g.clearRect(0, 0, 512, 160);
  g.fillStyle = 'rgba(13,14,17,0.82)';
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
  g.fillStyle = '#9a9890';
  g.font = `500 30px ${MONO}`;
  g.fillText(sub, 42, 104);
  // pointer
  g.fillStyle = 'rgba(13,14,17,0.82)';
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
  // wood grain
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

  // reason, wrapped
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

  // chips
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
  g.strokeStyle = 'rgba(255,255,255,0.12)';
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
  const t = new THREE.CanvasTexture(c);
  return t;
}

export { DISPLAY, MONO };
