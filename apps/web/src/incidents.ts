// Custom incidents (docs/superpowers/specs/2026-09-27-custom-incidents-design.md): the label helper the
// builder / HUD / car page share, and the thin client for /api/incidents. Mock mode never calls these fetches.
import type { CustomIncident, IncidentClass, TrackObstacle } from './types';
import { BARRIER_INCIDENT } from './types';

export type IncidentDraft = Pick<CustomIncident, 'title' | 'story' | 'cls' | 'ownerRequest' | 'content' | 'amountUsd'>;
export type IncidentSlim = Omit<CustomIncident, 'content' | 'ownerRequest'>;

/** A custom obstacle shows its own title; a preset shows the library name. Escape the result before innerHTML. */
export const obstacleTitle = (o: Pick<TrackObstacle, 'type' | 'custom'>) => o.custom?.title ?? BARRIER_INCIDENT[o.type];

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

export const draftIncident = (prompt: string, cls: IncidentClass) =>
  call<{ draft: IncidentDraft }>('/api/incidents/draft', { method: 'POST', body: JSON.stringify({ prompt, cls }) });
export const publishIncident = (d: IncidentDraft & { author: string }) =>
  call<{ incident: CustomIncident }>('/api/incidents', { method: 'POST', body: JSON.stringify(d) });
export const listIncidents = () => call<{ incidents: IncidentSlim[] }>('/api/incidents');
export const getIncident = (id: string) => call<{ incident: CustomIncident }>(`/api/incidents/${encodeURIComponent(id)}`);
