import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';
import { MANDATE_KEYS, RATING_KEYS, type Mandate, type Rating } from '@crumple/core';
import { carEnsName, dnsName, encodeMandateRecords, encodeRatingRecords, labelId, labelOf, parseMandateRecords, parseRatingRecords, ratingSummary, resolverResource, toLabel } from './records.js';

describe('names', () => {
  it('toLabel sanitises car ids into ENS labels', () => {
    expect(toLabel('Car_42 Fast!')).toBe('car-42-fast');
    expect(toLabel('abc')).toBe('abc');
    expect(() => toLabel('___')).toThrow();
  });
  it('carEnsName / labelOf round-trip', () => {
    expect(carEnsName('zx9')).toBe('zx9.naap.eth');
    expect(labelOf('zx9.naap.eth')).toBe('zx9');
    expect(labelOf('a.b.naap.eth')).toBeNull();
    expect(labelOf('vitalik.eth')).toBeNull();
  });
  it('labelId matches LibLabel.id (keccak of the label bytes)', () => {
    expect(labelId('eth')).toBe(BigInt('0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0'));
    expect(resolverResource('sekisho.payees')).toBe(BigInt(keccak256(stringToBytes('sekisho.payees'))));
  });
  it('dnsName is the DNS wire format', () => {
    expect(dnsName('zx9.naap.eth')).toBe('0x037a7839046e6161700365746800');
  });
});

describe('mandate records', () => {
  const m: Mandate = {
    ensName: 'zx9.naap.eth',
    owner: '0x0000000000000000000000000000000000000001',
    payees: [{ ens: 'Weather.naap.eth', address: '0x1111111111111111111111111111111111111111' }],
    perTxCapUsd: 5,
    dailyCapBps: 1000,
    expiresAt: 1_800_000_000,
    source: 'ens',
  };
  it('encodes to the core MANDATE_KEYS and parses back', () => {
    const recs = encodeMandateRecords(m);
    expect(recs.map((r) => r.key)).toEqual(Object.values(MANDATE_KEYS));
    const obj = Object.fromEntries(recs.map((r) => [r.key, r.value]));
    expect(obj[MANDATE_KEYS.payees]).toBe('weather.naap.eth');
    expect(parseMandateRecords(obj)).toEqual({ payees: ['weather.naap.eth'], perTxCapUsd: 5, dailyCapBps: 1000, expiresAt: 1_800_000_000 });
  });
  it('fractional caps survive', () => {
    const obj = Object.fromEntries(encodeMandateRecords({ ...m, perTxCapUsd: 2.5 }).map((r) => [r.key, r.value]));
    expect(parseMandateRecords(obj)?.perTxCapUsd).toBe(2.5);
  });
  it('returns null when nothing is written and throws on garbage', () => {
    expect(parseMandateRecords({})).toBeNull();
    expect(parseMandateRecords({ [MANDATE_KEYS.payees]: '', [MANDATE_KEYS.perTxCapUsd]: '5' })).toBeNull();
    expect(() => parseMandateRecords({ [MANDATE_KEYS.payees]: 'weather.naap.eth', [MANDATE_KEYS.perTxCapUsd]: 'lots' })).toThrow(/malformed/);
  });
});

describe('rating records', () => {
  const r: Rating = { stars: 5, bare: { stars: 1, lossUsd: 451.99, crashes: 2 }, airbag: { stars: 5, lossUsd: 0, crashes: 0 } };
  it('encodes to RATING_KEYS and parses back', () => {
    const recs = encodeRatingRecords(r, 1_700_000_000);
    expect(recs.map((x) => x.key)).toEqual(Object.values(RATING_KEYS));
    const obj = Object.fromEntries(recs.map((x) => [x.key, x.value]));
    expect(obj[RATING_KEYS.summary]).toBe('bare 1/5 · airbag 5/5');
    expect(obj[RATING_KEYS.runAt]).toBe('1700000000');
    const back = parseRatingRecords(obj)!;
    expect(back.stars).toBe(5);
    expect(back.bare.stars).toBe(1);
    expect(back.bare.lossUsd).toBe(451.99);
    expect(back.airbag.stars).toBe(5);
  });
  it('clamps stars', () => {
    expect(ratingSummary({ stars: 9, bare: { stars: -1, lossUsd: 0, crashes: 0 }, airbag: { stars: 7, lossUsd: 0, crashes: 0 } })).toBe('bare 0/5 · airbag 5/5');
    expect(parseRatingRecords({})).toBeNull();
  });
});
