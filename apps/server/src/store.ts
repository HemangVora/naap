import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BarrierResult, Car, CarPublic, CustomIncident, Hex, Rating, RunReport, TrackSpec } from '@crumple/core';
import { BARRIER_ORDER, DEFAULT_TRACK, DEFAULT_TRACK_ID } from '@crumple/core';
import { sortTracks, toPublic, type CarStore } from './public.js';

export { toPublic, MemoryStore, type CarStore } from './public.js';

// Loaded through require: vite (vitest) strips the `node:` prefix from `node:sqlite` imports and then cannot resolve it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Cars, tracks + results in node:sqlite. openaiApiKey is never stored. */
export class Store implements CarStore {
  private db: DatabaseSyncT;
  constructor(path = process.env.DB_PATH ?? 'data/crumple.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists cars (
        id text primary key, car text not null, rating text, rating_tx text, created_at integer not null
      );
      create table if not exists tracks (
        id text primary key, track text not null, is_default integer not null default 0, created_at integer not null
      );
      create table if not exists reports (
        car_id text primary key, report text not null, created_at integer not null
      );
      create table if not exists incidents (id text primary key, incident text not null, created_at integer not null);
    `);
    this.migrateResults();
    this.db.exec(`
      create table if not exists results (
        car_id text not null, run_id text not null, variant text not null, barrier_id text not null,
        step integer not null, track_id text not null, result text not null,
        primary key (run_id, step)
      );
      create index if not exists results_car on results (car_id);
    `);
    if (!this.getTrack(DEFAULT_TRACK_ID)) this.putTrack({ ...DEFAULT_TRACK, createdAt: Date.now() });
  }

  /** v1 results were keyed by (run_id, barrier_id) on the fixed five-barrier course: copy them into (run_id, step). */
  private migrateResults() {
    const cols = this.db.prepare('pragma table_info(results)').all() as { name: string }[];
    if (!cols.length || cols.some((c) => c.name === 'step')) return;
    const old = this.db.prepare('select result from results').all() as { result: string }[];
    this.db.exec('drop table results');
    this.db.exec(`
      create table results (
        car_id text not null, run_id text not null, variant text not null, barrier_id text not null,
        step integer not null, track_id text not null, result text not null,
        primary key (run_id, step)
      );
    `);
    for (const row of old) {
      const r = JSON.parse(row.result) as BarrierResult;
      this.putResult({ ...r, step: r.step ?? Math.max(0, BARRIER_ORDER.indexOf(r.barrierId)), trackId: r.trackId ?? DEFAULT_TRACK_ID });
    }
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
      .prepare('insert or replace into results (car_id, run_id, variant, barrier_id, step, track_id, result) values (?, ?, ?, ?, ?, ?, ?)')
      .run(r.carId, r.runId, r.variant, r.barrierId, r.step, r.trackId, JSON.stringify(r));
  }
  results(carId: string): BarrierResult[] {
    return (this.db.prepare('select result from results where car_id = ? order by run_id, step').all(carId) as { result: string }[]).map((r) =>
      JSON.parse(r.result),
    );
  }
  allResults(): BarrierResult[] {
    return (this.db.prepare('select result from results').all() as { result: string }[]).map((r) => JSON.parse(r.result));
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
  putTrack(t: TrackSpec) {
    this.db
      .prepare('insert or replace into tracks (id, track, is_default, created_at) values (?, ?, ?, ?)')
      .run(t.id, JSON.stringify(t), t.isDefault ? 1 : 0, t.createdAt);
  }
  getTrack(id: string): TrackSpec | undefined {
    const row = this.db.prepare('select track from tracks where id = ?').get(id) as { track: string } | undefined;
    return row ? (JSON.parse(row.track) as TrackSpec) : undefined;
  }
  tracks(limit = 200): TrackSpec[] {
    const rows = this.db.prepare('select track from tracks order by is_default desc, created_at desc limit ?').all(limit) as { track: string }[];
    return sortTracks(rows.map((r) => JSON.parse(r.track)));
  }
  trackCount(): number {
    return (this.db.prepare('select count(*) as n from tracks').get() as { n: number }).n;
  }
  putReport(r: RunReport) {
    this.db.prepare('insert or replace into reports (car_id, report, created_at) values (?, ?, ?)').run(r.carId, JSON.stringify(r), r.createdAt);
  }
  getReport(carId: string): RunReport | undefined {
    const row = this.db.prepare('select report from reports where car_id = ?').get(carId) as { report: string } | undefined;
    return row ? (JSON.parse(row.report) as RunReport) : undefined;
  }
  putIncident(i: CustomIncident) {
    this.db.prepare('insert or replace into incidents (id, incident, created_at) values (?, ?, ?)').run(i.id, JSON.stringify(i), i.createdAt);
  }
  getIncident(id: string): CustomIncident | undefined {
    const row = this.db.prepare('select incident from incidents where id = ?').get(id) as { incident: string } | undefined;
    return row ? (JSON.parse(row.incident) as CustomIncident) : undefined;
  }
  incidents(limit = 30): CustomIncident[] {
    const rows = this.db.prepare('select incident from incidents order by created_at desc limit ?').all(limit) as { incident: string }[];
    return rows.map((r) => JSON.parse(r.incident) as CustomIncident);
  }
  incidentCount(): number {
    return (this.db.prepare('select count(*) as n from incidents').get() as { n: number }).n;
  }
  bumpFooled(id: string) {
    const i = this.getIncident(id);
    if (i) this.putIncident({ ...i, fooled: i.fooled + 1 });
  }
  setIncidentEns(id: string, ensName: string, tx: string) {
    const i = this.getIncident(id);
    if (i) this.putIncident({ ...i, ensName, ensTx: tx });
  }
}
