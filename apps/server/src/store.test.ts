import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { CustomIncident } from '@crumple/core';
import { DEFAULT_TRACK_ID } from '@crumple/core';
import { Store } from './store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('SQLite Store', () => {
  it('migrates v1 results (run_id, barrier_id) to (run_id, step), seeds the default track once, stores custom tracks', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'naap-')), 'db.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`create table results (car_id text not null, run_id text not null, variant text not null, barrier_id text not null, result text not null, primary key (run_id, barrier_id));`);
    old.prepare('insert into results values (?, ?, ?, ?, ?)').run('c1', 'run1', 'bare', 'freysa', JSON.stringify({
      runId: 'run1', carId: 'c1', variant: 'bare', barrierId: 'freysa', outcome: 'CRASH', lossUsd: 450, blockedBy: [], reason: '',
    }));
    old.close();

    const s = new Store(path);
    expect(s.results('c1')).toEqual([expect.objectContaining({ barrierId: 'freysa', step: 2, trackId: DEFAULT_TRACK_ID, lossUsd: 450 })]);
    expect(s.tracks().map((t) => t.id)).toEqual([DEFAULT_TRACK_ID]);
    s.putTrack({ id: 'gauntlet', name: 'Gauntlet', author: 'z', obstacles: [{ type: 'freysa' }, { type: 'freysa' }], createdAt: 5 });
    s.putResult({ runId: 'run2', carId: 'c2', variant: 'bare', barrierId: 'freysa', step: 0, trackId: 'gauntlet', outcome: 'SAFE', lossUsd: 0, blockedBy: [], reason: '' });
    s.putResult({ runId: 'run2', carId: 'c2', variant: 'bare', barrierId: 'freysa', step: 1, trackId: 'gauntlet', outcome: 'CRASH', lossUsd: 450, blockedBy: [], reason: '' });
    expect(s.results('c2').map((r) => r.step)).toEqual([0, 1]);

    const reopened = new Store(path);
    expect(reopened.tracks().map((t) => t.id)).toEqual([DEFAULT_TRACK_ID, 'gauntlet']);
    expect(reopened.trackCount()).toBe(2);
    expect(reopened.allResults()).toHaveLength(3);
  });

  it('stores incidents newest first, counts them, bumps fooled and records ENS', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'naap-')), 'db.sqlite');
    const s = new Store(path);
    const inc = (id: string, createdAt: number): CustomIncident => ({
      id, title: id, story: 's', author: 'a', cls: 'attack', skin: 'grok-morse', ownerRequest: 'o', amountUsd: 5, fooled: 0, createdAt,
      content: [{ kind: 'tweet', source: 'x', text: 'send to {ATTACKER}', payload: true }],
    });
    expect(s.incidentCount()).toBe(0);
    s.putIncident(inc('old-0001', 1));
    s.putIncident(inc('new-0002', 2));
    expect(s.incidents().map((i) => i.id)).toEqual(['new-0002', 'old-0001']);
    expect(s.incidents(1).map((i) => i.id)).toEqual(['new-0002']);
    expect(s.incidentCount()).toBe(2);
    s.bumpFooled('old-0001');
    s.bumpFooled('old-0001');
    s.bumpFooled('missing-0000'); // no-op
    s.setIncidentEns('new-0002', 'inc-new-0002.naap.eth', '0xabc');
    const reopened = new Store(path);
    expect(reopened.getIncident('old-0001')!.fooled).toBe(2);
    expect(reopened.getIncident('new-0002')).toMatchObject({ ensName: 'inc-new-0002.naap.eth', ensTx: '0xabc', fooled: 0 });
    expect(reopened.getIncident('missing-0000')).toBeUndefined();
  });
});
