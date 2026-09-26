import type { FastifyInstance } from 'fastify';
import type { Address, Car, CarSpec, Integrations, Rating, RunDeps } from '@crumple/core';

export interface Wiring {
  deps: Omit<RunDeps, 'emit'>;
  integrations: Integrations;
  ownerAddress: Address;
  runCar(car: Car, spec: CarSpec, deps: RunDeps): Promise<Rating>;
  mountX402?(app: FastifyInstance): Promise<void>;
  close?(): Promise<void>;
}
