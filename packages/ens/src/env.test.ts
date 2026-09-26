import { describe, expect, it } from 'vitest';
import { createMandateSource, createRatingWriter, ensEnv } from './env.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('env selection (no network)', () => {
  it('defaults to local and only picks ens with mode + creds', () => {
    expect(ensEnv({}).mode).toBe('local');
    expect(ensEnv({ ENS_MODE: 'ens' }).mode).toBe('local');
    expect(ensEnv({ ENS_MODE: 'ens', RELAYER_PK: PK }).mode).toBe('local');
    expect(ensEnv({ ENS_MODE: 'ens', RELAYER_PK: 'nope', SEPOLIA_RPC_URL: 'http://x' }).mode).toBe('local');
    const e = ensEnv({ ENS_MODE: 'ens', RELAYER_PK: PK, SEPOLIA_RPC_URL: 'http://x', WEATHER_ADDRESS: '0x1111111111111111111111111111111111111111' });
    expect(e.mode).toBe('ens');
    expect(e.weatherAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('createMandateSource → local when ENS_MODE=local, and the rating writer follows', async () => {
    const src = await createMandateSource({ env: { ENS_MODE: 'local', RELAYER_PK: PK }, log: () => {} });
    expect(src.mode).toBe('local');
    const rw = createRatingWriter(src);
    expect(rw.mode).toBe('local');
  });

  it('createMandateSource → ens (unprobed) when creds exist, sharing one relayer', async () => {
    const env = { ENS_MODE: 'ens', RELAYER_PK: PK, SEPOLIA_RPC_URL: 'http://127.0.0.1:1' };
    const src = await createMandateSource({ env, probe: false, log: () => {} });
    expect(src.mode).toBe('ens');
    const rw = createRatingWriter(src);
    expect(rw.mode).toBe('ens');
    if (src.mode === 'ens') expect(src.relayer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('createMandateSource falls back to local when Sepolia is unreachable', async () => {
    const env = { ENS_MODE: 'ens', RELAYER_PK: PK, SEPOLIA_RPC_URL: 'http://127.0.0.1:9' };
    const src = await createMandateSource({ env, log: () => {} });
    expect(src.mode).toBe('local');
  }, 20_000);
});
