// Store contract + the Car → CarPublic projection. Kept free of node:sqlite so app.ts (and in-process tests)
// can use an in-memory store without loading the SQLite module.
import type { BarrierResult, Car, CarPublic, CustomIncident, Hex, Rating, RunReport, TrackSpec } from '@crumple/core';
import { DEFAULT_TRACK, DEFAULT_TRACK_ID } from '@crumple/core';

export interface CarStore {
  putCar(car: Car): void;
  getCar(id: string): Car | undefined;
  setRating(id: string, rating: Rating): void;
  setRatingTx(id: string, txHash: Hex): void;
  /** Keyed by (runId, step): a track may repeat a barrier type. */
  putResult(r: BarrierResult): void;
  results(carId: string): BarrierResult[];
  /** Every stored result (stats). */
  allResults(): BarrierResult[];
  ratings(): Rating[];
  publicCars(limit?: number): CarPublic[];
  publicCar(id: string): CarPublic | undefined;
  putTrack(t: TrackSpec): void;
  getTrack(id: string): TrackSpec | undefined;
  /** Default track first, then newest first. */
  tracks(limit?: number): TrackSpec[];
  trackCount(): number;
  /** End-of-run assessment (lane report). One per car. */
  putReport(r: RunReport): void;
  getReport(carId: string): RunReport | undefined;
  /** Custom incidents (visitor-authored obstacles). */
  putIncident(i: CustomIncident): void;
  getIncident(id: string): CustomIncident | undefined;
  /** Newest first. */
  incidents(limit?: number): CustomIncident[];
  incidentCount(): number;
  /** One more bare-lane CRASH credited to this incident. Unknown id = no-op. */
  bumpFooled(id: string): void;
  setIncidentEns(id: string, ensName: string, tx: string): void;
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
    trackId: car.spec.trackId ?? DEFAULT_TRACK_ID,
    rating,
    ratingOnchain: ratingTx ? { txHash: ratingTx } : null,
  };
}

/** Default track first, then newest first. */
export function sortTracks(ts: TrackSpec[]): TrackSpec[] {
  return ts.slice().sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || b.createdAt - a.createdAt);
}

/** In-memory CarStore (tests, and any environment without node:sqlite). */
export class MemoryStore implements CarStore {
  private cars = new Map<string, { car: Car; rating?: Rating; tx?: Hex }>();
  private res = new Map<string, BarrierResult>();
  private trackMap = new Map<string, TrackSpec>([[DEFAULT_TRACK.id, { ...DEFAULT_TRACK, createdAt: Date.now() }]]);
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
    this.res.set(`${r.runId}|${r.step}`, r);
  }
  results(carId: string) {
    return [...this.res.values()].filter((r) => r.carId === carId);
  }
  allResults() {
    return [...this.res.values()];
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
  putTrack(t: TrackSpec) {
    this.trackMap.set(t.id, t);
  }
  getTrack(id: string) {
    return this.trackMap.get(id);
  }
  tracks(limit = 200) {
    return sortTracks([...this.trackMap.values()]).slice(0, limit);
  }
  trackCount() {
    return this.trackMap.size;
  }
  private reportMap = new Map<string, RunReport>();
  putReport(r: RunReport) {
    this.reportMap.set(r.carId, r);
  }
  getReport(carId: string) {
    return this.reportMap.get(carId);
  }
  private incidentMap = new Map<string, CustomIncident>();
  putIncident(i: CustomIncident) {
    this.incidentMap.set(i.id, i);
  }
  getIncident(id: string) {
    return this.incidentMap.get(id);
  }
  incidents(limit = 30) {
    return [...this.incidentMap.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  incidentCount() {
    return this.incidentMap.size;
  }
  bumpFooled(id: string) {
    const i = this.incidentMap.get(id);
    if (i) i.fooled += 1;
  }
  setIncidentEns(id: string, ensName: string, tx: string) {
    const i = this.incidentMap.get(id);
    if (i) {
      i.ensName = ensName;
      i.ensTx = tx;
    }
  }
}
