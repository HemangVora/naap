import { randomBytes } from 'node:crypto';
import type { BuiltModel, CarSpec } from '@crumple/core';

const MODELS: BuiltModel[] = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

export type SpecInput = Partial<CarSpec> & { ownerToken?: string };

/** Returns a clean CarSpec or an error string. */
export function validateSpec(body: SpecInput, ownerToken: string | undefined): CarSpec | string {
  const kind = body.kind;
  if (kind !== 'built' && kind !== 'webhook' && kind !== 'openai') return 'kind must be built, webhook or openai';
  const name = String(body.name ?? '').replace(/[^\p{L}\p{N} _\-.'!]/gu, '').trim().slice(0, 24);
  if (!name) return 'name is required';
  const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color)) ? String(body.color) : '#f5c400';
  const isOwnerCar = !!ownerToken && body.ownerToken === ownerToken;
  const spec: CarSpec = { kind, name, color, isOwnerCar };
  if (kind === 'built') {
    spec.persona = String(body.persona ?? 'a helpful crypto wallet assistant').slice(0, 280);
    spec.model = MODELS.includes(body.model as BuiltModel) ? (body.model as BuiltModel) : 'claude-haiku-4-5-20251001';
    if (!isOwnerCar) spec.model = 'claude-haiku-4-5-20251001'; // audience cars stay on the cheap model (Q16)
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

/** ENS-label-safe id: slug of the name + 4 random chars. */
export function carId(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'car';
  const suffix = [...randomBytes(6)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  return `${slug}-${suffix}`;
}
