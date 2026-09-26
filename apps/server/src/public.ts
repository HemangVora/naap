// Store contract + the Car → CarPublic projection. Kept free of node:sqlite so app.ts (and in-process tests)
// can use an in-memory store without loading the SQLite module.
import type { BarrierResult, Car, CarPublic, Hex, Rating } from '@crumple/core';

export interface CarStore {
  putCar(car: Car): void;
  getCar(id: string): Car | undefined;
  setRating(id: string, rating: Rating): void;
  setRatingTx(id: string, txHash: Hex): void;
  putResult(r: BarrierResult): void;
  results(carId: string): BarrierResult[];
  ratings(): Rating[];
  publicCars(limit?: number): CarPublic[];
  publicCar(id: string): CarPublic | undefined;
}

export function toPublic(car: Car, rating?: Rating, ratingTx?: Hex | null): CarPublic {
  return {
    id: car.id,
    name: car.spec.name,
    color: car.spec.color,
    kind: car.spec.kind,
    model: car.spec.kind === 'built' ? car.spec.model : car.spec.kind === 'openai' ? car.spec.openaiModel : undefined,
    ensName: car.ensName,
    isOwnerCar: !!car.spec.isOwnerCar,
    rating,
    ratingOnchain: ratingTx ? { txHash: ratingTx } : null,
  };
}

/** In-memory CarStore (tests, and any environment without node:sqlite). */
export class MemoryStore implements CarStore {
  private cars = new Map<string, { car: Car; rating?: Rating; tx?: Hex }>();
  private res = new Map<string, BarrierResult>();
  putCar(car: Car) {
    this.cars.set(car.id, { car });
  }
  getCar(id: string) {
    return this.cars.get(id)?.car;
  }
  setRating(id: string, rating: Rating) {
    const r = this.cars.get(id);
    if (r) r.rating = rating;
  }
  setRatingTx(id: string, txHash: Hex) {
    const r = this.cars.get(id);
    if (r) r.tx = txHash;
  }
  putResult(r: BarrierResult) {
    this.res.set(`${r.runId}|${r.barrierId}`, r);
  }
  results(carId: string) {
    return [...this.res.values()].filter((r) => r.carId === carId);
  }
  ratings() {
    return [...this.cars.values()].flatMap((r) => (r.rating ? [r.rating] : []));
  }
  publicCars(limit = 50) {
    return [...this.cars.values()]
      .sort((a, b) => b.car.createdAt - a.car.createdAt)
      .slice(0, limit)
      .map((r) => toPublic(r.car, r.rating, r.tx));
  }
  publicCar(id: string) {
    const r = this.cars.get(id);
    return r ? toPublic(r.car, r.rating, r.tx) : undefined;
  }
}
