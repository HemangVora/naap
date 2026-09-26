import type { FastifyInstance } from 'fastify';
import type { Address, Car, CarSpec, Integrations, Rating, RunDeps, TrackSpec } from '@crumple/core';
import type { DraftLlm } from './incidents.js';

/** Publishes a custom incident as `inc-<id>.naap.eth` with its text records (Task 5 wires the real one). */
export interface IncidentsEns {
  register(label: string): Promise<unknown>;
  writeText(ensName: string, records: { key: string; value: string }[]): Promise<{ status: string; hash: string }>;
}

export interface Wiring {
  deps: Omit<RunDeps, 'emit'>;
  integrations: Integrations;
  ownerAddress: Address;
  /** Drives `track` (the car's chosen track, resolved by the server). */
  runCar(car: Car, spec: CarSpec, deps: RunDeps, track: TrackSpec): Promise<Rating>;
  mountX402?(app: FastifyInstance): Promise<void>;
  /** On-chain publication of custom incidents; absent = incidents stay off-chain. */
  incidentsEns?: IncidentsEns;
  /** AI drafter for POST /api/incidents/draft; absent = template drafts. */
  draftLlm?: DraftLlm;
  close?(): Promise<void>;
}
