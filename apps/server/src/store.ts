import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BarrierResult, Car, CarPublic, Hex, Rating } from '@crumple/core';

/** Cars + results in node:sqlite. openaiApiKey is never stored. */
export class Store {
  private db: DatabaseSync;
  constructor(path = process.env.DB_PATH ?? 'data/crumple.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists cars (
        id text primary key, car text not null, rating text, rating_tx text, created_at integer not null
      );
      create table if not exists results (
        car_id text not null, run_id text not null, variant text not null, barrier_id text not null, result text not null,
        primary key (run_id, barrier_id)
      );
    `);
  }
  putCar(car: Car) {
    this.db.prepare('insert or replace into cars (id, car, created_at) values (?, ?, ?)').run(car.id, JSON.stringify(car), car.createdAt);
  }
  getCar(id: string): Car | undefined {
    const row = this.db.prepare('select car from cars where id = ?').get(id) as { car: string } | undefined;
    return row ? (JSON.parse(row.car) as Car) : undefined;
  }
  setRating(id: string, rating: Rating) {
    this.db.prepare('update cars set rating = ? where id = ?').run(JSON.stringify(rating), id);
  }
  setRatingTx(id: string, txHash: Hex) {
    this.db.prepare('update cars set rating_tx = ? where id = ?').run(txHash, id);
  }
  putResult(r: BarrierResult) {
    this.db
      .prepare('insert or replace into results (car_id, run_id, variant, barrier_id, result) values (?, ?, ?, ?, ?)')
      .run(r.carId, r.runId, r.variant, r.barrierId, JSON.stringify(r));
  }
  results(carId: string): BarrierResult[] {
    return (this.db.prepare('select result from results where car_id = ?').all(carId) as { result: string }[]).map((r) => JSON.parse(r.result));
  }
  ratings(): Rating[] {
    return (this.db.prepare('select rating from cars where rating is not null').all() as { rating: string }[]).map((r) => JSON.parse(r.rating));
  }
  publicCars(limit = 50): CarPublic[] {
    const rows = this.db.prepare('select car, rating, rating_tx from cars order by created_at desc limit ?').all(limit) as {
      car: string; rating: string | null; rating_tx: string | null;
    }[];
    return rows.map((r) => toPublic(JSON.parse(r.car), r.rating ? JSON.parse(r.rating) : undefined, r.rating_tx as Hex | null));
  }
  publicCar(id: string): CarPublic | undefined {
    const r = this.db.prepare('select car, rating, rating_tx from cars where id = ?').get(id) as
      | { car: string; rating: string | null; rating_tx: string | null } | undefined;
    return r ? toPublic(JSON.parse(r.car), r.rating ? JSON.parse(r.rating) : undefined, r.rating_tx as Hex | null) : undefined;
  }
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
