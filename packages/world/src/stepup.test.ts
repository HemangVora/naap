// No network, no keys: fetch is mocked, the JWKS is generated locally, and the clock is virtual.
import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createStepUp, isLive } from './index.js';

const ISSUER = 'https://sandbox.auth.world.org';
const CLIENT_ID = 'client_test_123';
const CLIENT_SECRET = 'sekret-never-logged';

// ── local RS256 key + JWKS ───────────────────────────────────────────────────
const keys = await generateKeyPair('RS256');
const pubJwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const getKey = createLocalJWKSet({ keys: [pubJwk] });
const otherKeys = await generateKeyPair('RS256');

async function idToken(overrides: { iss?: string; aud?: string; auth_time?: number; sub?: string; key?: CryptoKey | import('node:crypto').KeyObject; exp?: number; nowSec: number }) {
  const { nowSec } = overrides;
  return new SignJWT({ auth_time: overrides.auth_time ?? nowSec, acr: 'https://world.org/oidc/acr/orb-v3', amr: ['pop'], jti: 'j1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setSubject(overrides.sub ?? 'sub_pairwise_abcdef0123456789')
    .setIssuedAt(nowSec)
    .setExpirationTime(overrides.exp ?? nowSec + 300)
    .sign((overrides.key as any) ?? keys.privateKey);
}

// ── virtual clock ────────────────────────────────────────────────────────────
function clock(startMs = 1_800_000_000_000) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    sec: () => Math.floor(t / 1000),
  };
}

// ── fetch mock: discovery + device_authorization + a scripted token endpoint ─
type TokenStep = { status: number; body: unknown } | ((nowSec: number) => Promise<{ status: number; body: unknown }>);
function mockFetch(opts: { tokenSteps: TokenStep[]; deviceExpiresIn?: number; interval?: number; nowSec: () => number }) {
  const calls: { url: string; body: URLSearchParams | null; headers: Record<string, string> }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    calls.push({ url, body, headers: (init?.headers as Record<string, string>) ?? {} });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json(200, {
        issuer: ISSUER,
        device_authorization_endpoint: `${ISSUER}/api/v1/device_authorization`,
        token_endpoint: `${ISSUER}/api/v1/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      });
    }
    if (url.endsWith('/api/v1/device_authorization')) {
      if (body?.get('client_id') !== CLIENT_ID || body?.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      if (body?.get('scope') !== 'openid') return json(400, { error: 'invalid_scope' });
      return json(200, {
        device_code: 'dev-secret-code',
        user_code: 'ABCD-1234',
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-1234`,
        expires_in: opts.deviceExpiresIn ?? 1200,
        interval: opts.interval ?? 5,
      });
    }
    if (url.endsWith('/api/v1/token')) {
      if (body?.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code') return json(400, { error: 'unsupported_grant_type' });
      if (body?.get('device_code') !== 'dev-secret-code') return json(400, { error: 'invalid_grant' });
      const step = opts.tokenSteps.shift();
      if (!step) return json(400, { error: 'authorization_pending' });
      const r = typeof step === 'function' ? await step(opts.nowSec()) : step;
      return json(r.status, r.body);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function live(fetch: typeof globalThis.fetch, c: ReturnType<typeof clock>, logs: string[] = []) {
  return createStepUp({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch, getKey, now: c.now, sleep: c.sleep, log: (l) => logs.push(l) });
}

const ownerReq = { carId: 'owner', intentId: 'i1', summary: 'Pay $40 to weather.naap.eth', ttlSec: 300, allowApproval: true };

describe('createStepUp (live, owner car)', () => {
  it('APPROVES on a valid ID token with fresh auth_time; polls respecting interval and slow_down', async () => {
    const c = clock();
    const logs: string[] = [];
    const m = mockFetch({
      nowSec: c.sec,
      tokenSteps: [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        { status: 400, body: { error: 'authorization_pending' } },
        async (nowSec) => ({ status: 200, body: { id_token: await idToken({ nowSec, auth_time: nowSec - 2 }), access_token: 'opaque', token_type: 'Bearer', expires_in: 300 } }),
      ],
    });
    const s = live(m.fetch, c, logs);
    expect(s.live).toBe(true);
    const t0 = c.now();
    const h = await s.request(ownerReq);
    expect(h.verificationUri).toBe(`${ISSUER}/device?user_code=ABCD-1234`);
    expect(h.userCode).toBe('ABCD-1234');
    expect(h.expiresAt).toBe(t0 + 300_000); // our ttl (300 s) < device code (1200 s)
    const r = await h.result;
    expect(r.status).toBe('APPROVED');
    expect(r.subject).toBe('sub_pairwise_abcdef0123456789');
    expect(r.authTime).toBeGreaterThanOrEqual(Math.floor(t0 / 1000) - 60);
    expect(r.detail).toMatch(/^Owner approved with World ID \(sub_pa…6789\) — fresh proof \d+ s after the request$/);
    // 4 polls: 5 s, 5 s, then +5 s after slow_down → 10 s, 10 s = 30 s total elapsed
    expect(c.now() - t0).toBe(30_000);
    const polls = m.calls.filter((x) => x.url.endsWith('/api/v1/token'));
    expect(polls).toHaveLength(4);
    // the secret is sent to World but never logged
    expect(logs.join('\n')).not.toContain(CLIENT_SECRET);
    expect(logs.join('\n')).not.toContain('dev-secret-code');
  });

  it('DENIED when the owner rejects in World App (access_denied)', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [{ status: 400, body: { error: 'authorization_pending' } }, { status: 400, body: { error: 'access_denied' } }] });
    const r = await (await live(m.fetch, c).request(ownerReq)).result;
    expect(r.status).toBe('DENIED');
    expect(r.detail).toBe('Owner denied the request in World App — payment refused');
  });

  it('EXPIRED at our ttl when nobody approves (device code still alive)', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [] }); // always authorization_pending
    const t0 = c.now();
    const h = await live(m.fetch, c).request({ ...ownerReq, ttlSec: 60 });
    expect(h.expiresAt).toBe(t0 + 60_000);
    const r = await h.result;
    expect(r.status).toBe('EXPIRED');
    expect(r.detail).toBe('No owner step-up within 60 s — payment refused');
    expect(c.now()).toBe(t0 + 60_000);
    // polled at 5,10,...,55 then stopped at 60 without another poll (bounded by expiry)
    expect(m.calls.filter((x) => x.url.endsWith('/api/v1/token')).length).toBe(11);
  });

  it('EXPIRED when World reports the device code expired', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [{ status: 400, body: { error: 'expired_token' } }] });
    const r = await (await live(m.fetch, c).request(ownerReq)).result;
    expect(r.status).toBe('EXPIRED');
    expect(r.detail).toMatch(/device code expired/);
  });

  it('handle.expiresAt uses the device-code expiry when it is shorter than ttl', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [], deviceExpiresIn: 30 });
    const t0 = c.now();
    const h = await live(m.fetch, c).request(ownerReq);
    expect(h.expiresAt).toBe(t0 + 30_000);
    const r = await h.result;
    expect(r.status).toBe('EXPIRED');
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }, /audience mismatch/],
    ['wrong issuer', { iss: 'https://evil.example' }, /issuer mismatch/],
    ['stale auth_time (proof from before the request)', { auth_time: -600 }, /stale/],
    ['expired token', { exp: -120 }, /token expired/],
    ['signed by an unknown key', { key: otherKeys.privateKey }, /signature|key/],
  ])('rejects an ID token with %s — never APPROVED', async (_name, ov: any, re) => {
    const c = clock();
    const m = mockFetch({
      nowSec: c.sec,
      tokenSteps: [
        async (nowSec) => ({
          status: 200,
          body: {
            id_token: await idToken({
              nowSec,
              iss: ov.iss,
              aud: ov.aud,
              key: ov.key,
              auth_time: ov.auth_time !== undefined ? nowSec + ov.auth_time : undefined,
              exp: ov.exp !== undefined ? nowSec + ov.exp : undefined,
            }),
          },
        }),
      ],
    });
    const r = await (await live(m.fetch, c).request(ownerReq)).result;
    expect(r.status).toBe('DENIED');
    expect(r.detail).toMatch(re);
    expect(r.detail).toMatch(/payment refused$/);
  });

  it('accepts auth_time within clock skew of the request', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [async (nowSec) => ({ status: 200, body: { id_token: await idToken({ nowSec, auth_time: Math.floor(c.now() / 1000) - 30 }) } })] });
    const r = await (await live(m.fetch, c).request(ownerReq)).result;
    expect(r.status).toBe('APPROVED');
  });

  it('does not throw when the device grant cannot start (bad credentials) — resolves EXPIRED with the reason', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [] });
    const s = createStepUp({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'wrong', fetch: m.fetch, getKey, now: c.now, sleep: c.sleep, log: () => {} });
    const h = await s.request(ownerReq);
    expect(h.verificationUri).toBeUndefined();
    const r = await h.result;
    expect(r.status).toBe('EXPIRED');
    expect(r.detail).toMatch(/invalid_client/);
  });

  it('client_secret_basic sends the Authorization header and no secret in the body', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [] });
    // mock only accepts secret in body, so basic auth is refused with invalid_client — assert the wire shape instead
    const s = createStepUp({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, authMethod: 'client_secret_basic', fetch: m.fetch, getKey, now: c.now, sleep: c.sleep, log: () => {} });
    await s.request(ownerReq);
    const start = m.calls.find((x) => x.url.endsWith('/api/v1/device_authorization'))!;
    expect(start.headers.authorization).toMatch(/^Basic /);
    expect(start.body?.get('client_secret')).toBeNull();
    expect(start.body?.get('client_id')).toBe(CLIENT_ID);
  });
});

describe('createStepUp (audience car)', () => {
  it('makes no network call and EXPIRES after ttlSec with the projector wording', async () => {
    const c = clock();
    const m = mockFetch({ nowSec: c.sec, tokenSteps: [] });
    const t0 = c.now();
    const h = await live(m.fetch, c).request({ carId: 'aud', intentId: 'i2', summary: 'Pay $40', ttlSec: 60, allowApproval: false });
    expect(h.verificationUri).toBeUndefined();
    expect(h.userCode).toBeUndefined();
    expect(h.expiresAt).toBe(t0 + 60_000);
    const r = await h.result;
    expect(r).toEqual({ status: 'EXPIRED', detail: 'No owner step-up within 60 s — payment refused' });
    expect(m.calls).toHaveLength(0);
    expect(c.now()).toBe(t0 + 60_000);
  });
});

describe('offline fallback', () => {
  it('isLive() reflects the env', () => {
    expect(isLive({})).toBe(false);
    expect(isLive({ WORLD_CLIENT_ID: 'x' })).toBe(false);
    expect(isLive({ WORLD_CLIENT_ID: 'x', WORLD_CLIENT_SECRET: 'y' })).toBe(true);
  });

  it('falls back to the core FakeStepUp and flags offline when credentials are missing', async () => {
    const logs: string[] = [];
    const s = createStepUp({ log: (l) => logs.push(l) });
    expect(s.live).toBe(false);
    expect(s.mode).toBe('offline');
    expect(logs[0]).toMatch(/OFFLINE/);
    const r = await (await s.request(ownerReq)).result;
    expect(r.status).toBe('APPROVED');
    expect(r.detail).toBe('fake approval');
  });
});
