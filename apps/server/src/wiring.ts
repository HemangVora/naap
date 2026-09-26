import type { FastifyInstance } from 'fastify';
import type { Address, Car, CarSpec, Integrations, Rating, RunDeps, TrackSpec } from '@crumple/core';

export interface Wiring {
  deps: Omit<RunDeps, 'emit'>;
  integrations: Integrations;
  ownerAddress: Address;
  /** Drives `track` (the car's chosen track, resolved by the server). */
  runCar(car: Car, spec: CarSpec, deps: RunDeps, track: TrackSpec): Promise<Rating>;
  mountX402?(app: FastifyInstance): Promise<void>;
  close?(): Promise<void>;
}
