import { randomBytes } from 'node:crypto';
import type { BarrierId, BuiltModel, CarSpec, CustomIncident, Obfuscation, TrackObstacle, TrackSpec } from '@crumple/core';
import { TRACK_LIMITS } from '@crumple/core';

const MODELS: BuiltModel[] = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];
/** An owner-pasted agent system prompt (built cars). Mirrors MAX_SYSTEM_PROMPT in the course's ClaudeDriver. */
export const MAX_SYSTEM_PROMPT = 4000;

export type SpecInput = Partial<CarSpec> & { ownerToken?: string };

/** Returns a clean CarSpec or an error string. */
export function validateSpec(body: SpecInput, ownerToken: string | undefined): CarSpec | string {
  const kind = body.kind;
  if (kind !== 'built' && kind !== 'webhook' && kind !== 'openai' && kind !== 'mcp') return 'kind must be built, webhook, openai or mcp';
  const name = String(body.name ?? '').replace(/[^\p{L}\p{N} _\-.'!]/gu, '').trim().slice(0, 24);
  if (!name) return 'name is required';
  const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color)) ? String(body.color) : '#f5c400';
  const isOwnerCar = !!ownerToken && body.ownerToken === ownerToken;
  const spec: CarSpec = { kind, name, color, isOwnerCar };
  if (body.trackId !== undefined && body.trackId !== null && body.trackId !== '') {
    if (typeof body.trackId !== 'string' || !/^[a-z0-9-]{1,48}$/.test(body.trackId)) return 'trackId must be a track slug';
    spec.trackId = body.trackId; // existence is checked against the track registry by the caller
  }
  if (kind === 'mcp') return spec; // driven by the owner's own agent over the MCP session that created it
  if (kind === 'built') {
    spec.persona = String(body.persona ?? 'a helpful crypto wallet assistant').slice(0, 280);
    spec.model = MODELS.includes(body.model as BuiltModel) ? (body.model as BuiltModel) : 'claude-haiku-4-5-20251001';
    if (!isOwnerCar) spec.model = 'claude-haiku-4-5-20251001'; // audience cars stay on the cheap model (Q16)
    if (body.systemPrompt !== undefined && body.systemPrompt !== null) {
      if (typeof body.systemPrompt !== 'string') return 'systemPrompt must be a string';
      const sp = body.systemPrompt.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      if (sp.length > MAX_SYSTEM_PROMPT) return `systemPrompt must be at most ${MAX_SYSTEM_PROMPT} characters`;
      if (sp) spec.systemPrompt = sp;
    }
    return spec;
  }
  let url: URL;
  try {
    url = new URL(String(body.endpoint ?? ''));
  } catch {
    return 'endpoint must be a URL';
  }
  if (url.protocol !== 'https:' && process.env.NODE_ENV !== 'development') return 'endpoint must be https';
  spec.endpoint = url.toString();
  if (kind === 'openai') {
    spec.openaiModel = String(body.openaiModel ?? '').slice(0, 80);
    if (!spec.openaiModel) return 'openaiModel is required';
    spec.openaiApiKey = body.openaiApiKey ? String(body.openaiApiKey).slice(0, 400) : undefined;
  }
  return spec;
}

/** ENS-label-safe id: slug of the name + 6 random chars. `inc-` is reserved for incident labels (inc-<id>.naap.eth). */
export function carId(name: string): string {
  let slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'car';
  if (slug.startsWith('inc-')) slug = `car-${slug.slice(4)}`;
  const suffix = [...randomBytes(6)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  return `${slug}-${suffix}`;
}

// ─── tracks ──────────────────────────────────────────────────────────────────

const BARRIER_TYPES: BarrierId[] = ['legit', 'grok-morse', 'freysa', 'x402-swap', 'over-limit'];
const OBFUSCATIONS: Obfuscation[] = ['none', 'morse', 'base64', 'hex'];
/** Obstacles whose attack text can be disguised. */
const OBFUSCATABLE: BarrierId[] = ['grok-morse', 'freysa', 'x402-swap'];

export interface TrackInput {
  name?: unknown;
  author?: unknown;
  obstacles?: unknown;
}

const clean = (v: unknown) =>
  String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Returns a clean track (without id/createdAt) or an error string. An obstacle with `incidentId` is resolved through
 * `lookup` and embedded as a server-side snapshot: its type is the incident's skin, and any client-sent `custom`,
 * `type` or `amountUsd` on it is dropped.
 */
export function validateTrack(body: TrackInput, lookup?: (id: string) => CustomIncident | undefined): Omit<TrackSpec, 'id' | 'createdAt'> | string {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const name = clean(body.name);
  if (!name || name.length > TRACK_LIMITS.nameMax) return `name must be 1–${TRACK_LIMITS.nameMax} characters`;
  const author = clean(body.author);
  if (!author || author.length > TRACK_LIMITS.authorMax) return `author must be 1–${TRACK_LIMITS.authorMax} characters`;
  if (!Array.isArray(body.obstacles)) return 'obstacles must be an array';
  if (body.obstacles.length < TRACK_LIMITS.minObstacles || body.obstacles.length > TRACK_LIMITS.maxObstacles)
    return `a track has ${TRACK_LIMITS.minObstacles}–${TRACK_LIMITS.maxObstacles} obstacles`;
  const obstacles: TrackObstacle[] = [];
  for (const [i, raw] of body.obstacles.entries()) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return `obstacle ${i + 1} must be an object`;
    if (typeof o.incidentId === 'string') {
      const inc = lookup?.(o.incidentId);
      if (!inc) return `obstacle ${i + 1}: unknown incident`;
      const ob: TrackObstacle = { type: inc.skin, incidentId: inc.id, custom: inc };
      if (o.obfuscation !== undefined && o.obfuscation !== null) {
        if (!OBFUSCATIONS.includes(o.obfuscation as Obfuscation)) return `obstacle ${i + 1}: obfuscation must be one of ${OBFUSCATIONS.join(', ')}`;
        if (inc.cls === 'attack') ob.obfuscation = o.obfuscation as Obfuscation; // a legit toll has nothing to disguise
      }
      obstacles.push(ob);
      continue;
    }
    if (!BARRIER_TYPES.includes(o.type as BarrierId)) return `obstacle ${i + 1}: type must be one of ${BARRIER_TYPES.join(', ')}`;
    const ob: TrackObstacle = { type: o.type as BarrierId };
    if (o.obfuscation !== undefined && o.obfuscation !== null) {
      if (!OBFUSCATIONS.includes(o.obfuscation as Obfuscation)) return `obstacle ${i + 1}: obfuscation must be one of ${OBFUSCATIONS.join(', ')}`;
      if (OBFUSCATABLE.includes(ob.type)) ob.obfuscation = o.obfuscation as Obfuscation;
    }
    if (o.amountUsd !== undefined && o.amountUsd !== null) {
      const n = Number(o.amountUsd);
      if (typeof o.amountUsd === 'boolean' || !Number.isFinite(n) || n <= 0 || n > TRACK_LIMITS.maxAmountUsd)
        return `obstacle ${i + 1}: amountUsd must be > 0 and ≤ ${TRACK_LIMITS.maxAmountUsd}`;
      ob.amountUsd = Math.round(n * 100) / 100 || 0.01;
    }
    obstacles.push(ob);
  }
  return { name, author, obstacles };
}

/** URL-safe slug for a track id (uniqueness is the caller's job). */
export function trackSlug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'track';
}

export function randomSuffix(n = 4): string {
  return [...randomBytes(n)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
