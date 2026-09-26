// World ID step-up for the over-limit barrier.
// Owner car (allowApproval:true): real RFC 8628 device grant against sandbox.auth.world.org.
// Audience cars (allowApproval:false): no network — EXPIRED after ttlSec.
import { FakeStepUp, type StepUp, type StepUpHandle, type StepUpRequest, type StepUpResult } from '@crumple/core';
import type { JWTVerifyGetKey } from 'jose';
import { DEFAULT_ISSUER, OidcError, WorldOidcClient, shortSub, type ClientAuthMethod } from './oidc.js';

export interface WorldConfig {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  authMethod?: ClientAuthMethod;
  /** Tolerated clock skew (seconds) when checking auth_time ≥ request time. */
  authTimeSkewSec?: number;
  fetch?: typeof fetch;
  /** Injectable clock (ms) and sleep — tests drive a virtual clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: local JWKS instead of the remote one. */
  getKey?: JWTVerifyGetKey;
  log?: (line: string) => void;
}

export interface WorldStepUp extends StepUp {
  /** true when real device grants are issued; false when the core FakeStepUp is standing in. */
  readonly live: boolean;
  readonly mode: 'live' | 'offline';
  readonly issuer: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorldConfig {
  const authMethod = env.WORLD_CLIENT_AUTH === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post';
  return {
    issuer: env.WORLD_ISSUER || DEFAULT_ISSUER,
    clientId: env.WORLD_CLIENT_ID || undefined,
    clientSecret: env.WORLD_CLIENT_SECRET || undefined,
    authMethod,
  };
}

/** True when WORLD_CLIENT_ID and WORLD_CLIENT_SECRET are both set (a live device grant can be issued). */
export function isLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WORLD_CLIENT_ID && env.WORLD_CLIENT_SECRET);
}

export function createStepUp(cfg: WorldConfig = configFromEnv()): WorldStepUp {
  const log = cfg.log ?? ((line: string) => console.error(`[world] ${line}`));
  const issuer = (cfg.issuer ?? DEFAULT_ISSUER).replace(/\/$/, '');
  if (!cfg.clientId || !cfg.clientSecret) {
    log('OFFLINE — WORLD_CLIENT_ID / WORLD_CLIENT_SECRET not set; using core FakeStepUp (no real World ID proofs). UI must show "World offline".');
    const fake = new FakeStepUp(true, 20);
    return { live: false, mode: 'offline', issuer, request: (req) => fake.request(req) };
  }
  const client = new WorldOidcClient({
    issuer,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authMethod: cfg.authMethod,
    fetch: cfg.fetch,
    getKey: cfg.getKey,
    now: cfg.now,
  });
  return new LiveStepUp(client, cfg, log);
}

class LiveStepUp implements WorldStepUp {
  readonly live = true;
  readonly mode = 'live' as const;
  readonly issuer: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly skewSec: number;

  constructor(private readonly client: WorldOidcClient, cfg: WorldConfig, private readonly log: (l: string) => void) {
    this.issuer = client.issuer;
    this.now = cfg.now ?? (() => Date.now());
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.skewSec = cfg.authTimeSkewSec ?? 60;
  }

  async request(req: StepUpRequest): Promise<StepUpHandle> {
    const id = `stepup-${req.intentId}`;
    const requestedAt = this.now();
    if (!req.allowApproval) return this.audience(id, req, requestedAt);

    // Owner car: real device grant. Never throw — a failure to start is a refused payment, not a crashed run.
    let da;
    try {
      da = await this.client.deviceAuthorization();
    } catch (e) {
      const msg = e instanceof OidcError ? e.message : `approval provider unreachable: ${(e as Error).message}`;
      this.log(`step-up ${id}: could not start device grant — ${msg}`);
      const detail = `Owner approval could not start (${msg}) — payment refused`;
      return { id, expiresAt: requestedAt, result: Promise.resolve({ status: 'EXPIRED', detail }) };
    }
    const deviceExpiry = requestedAt + da.expires_in * 1000;
    const expiresAt = Math.min(deviceExpiry, requestedAt + req.ttlSec * 1000);
    const verificationUri = da.verification_uri_complete ?? da.verification_uri;
    this.log(`step-up ${id}: device grant started, code ${da.user_code}, ${Math.round((expiresAt - requestedAt) / 1000)} s to approve`);

    const result = this.poll(id, req, da.device_code, da.interval ?? 5, requestedAt, expiresAt);
    return { id, verificationUri, userCode: da.user_code, expiresAt, result };
  }

  private async audience(id: string, req: StepUpRequest, requestedAt: number): Promise<StepUpHandle> {
    const expiresAt = requestedAt + req.ttlSec * 1000;
    const result = this.sleep(req.ttlSec * 1000).then<StepUpResult>(() => ({
      status: 'EXPIRED',
      detail: `No owner step-up within ${req.ttlSec} s — payment refused`,
    }));
    return { id, expiresAt, result };
  }

  private async poll(id: string, req: StepUpRequest, deviceCode: string, intervalSec: number, requestedAt: number, expiresAt: number): Promise<StepUpResult> {
    let interval = Math.max(1, intervalSec) * 1000;
    const ttlDetail = `No owner step-up within ${req.ttlSec} s — payment refused`;
    for (;;) {
      const remaining = expiresAt - this.now();
      if (remaining <= 0) return this.finish(id, { status: 'EXPIRED', detail: ttlDetail });
      await this.sleep(Math.min(interval, remaining));
      if (this.now() >= expiresAt) return this.finish(id, { status: 'EXPIRED', detail: ttlDetail });

      const r = await this.client.pollToken(deviceCode);
      switch (r.kind) {
        case 'pending':
          continue;
        case 'slow_down':
          interval += 5000;
          continue;
        case 'denied':
          return this.finish(id, { status: 'DENIED', detail: 'Owner denied the approval request — payment refused' });
        case 'expired':
          return this.finish(id, { status: 'EXPIRED', detail: 'Approval device code expired before approval — payment refused' });
        case 'error':
          if (r.status === 0 || r.status === 429) {
            // transient: back off and keep trying until our own ttl
            interval += 5000;
            this.log(`step-up ${id}: transient poll failure (${r.error}); backing off`);
            continue;
          }
          return this.finish(id, { status: 'EXPIRED', detail: `Approval provider error (${r.error}) — payment refused` });
        case 'token':
          return this.finish(id, await this.validate(r.id_token, requestedAt));
      }
    }
  }

  /** Backend validation: signature, iss, aud, exp (jose) + auth_time fresh relative to this request. */
  private async validate(idToken: string, requestedAt: number): Promise<StepUpResult> {
    let payload;
    try {
      payload = await this.client.verifyIdToken(idToken);
    } catch (e) {
      const why = describeJoseError(e);
      return { status: 'DENIED', detail: `Owner approval token rejected (${why}) — payment refused` };
    }
    const sub = String(payload.sub);
    const authTime = Number(payload.auth_time);
    const requestedSec = Math.floor(requestedAt / 1000);
    if (!Number.isFinite(authTime)) {
      return { status: 'DENIED', subject: sub, detail: 'Owner approval token rejected (no auth_time) — payment refused' };
    }
    if (authTime < requestedSec - this.skewSec) {
      return {
        status: 'DENIED',
        subject: sub,
        authTime,
        detail: `Owner approval is stale (auth_time ${requestedSec - authTime} s before the request) — payment refused`,
      };
    }
    const after = Math.max(0, authTime - requestedSec);
    return {
      status: 'APPROVED',
      subject: sub,
      authTime,
      detail: `Owner approved (${shortSub(sub)}) — fresh approval ${after} s after the request`,
    };
  }

  private finish(id: string, r: StepUpResult): StepUpResult {
    this.log(`step-up ${id}: ${r.status} — ${r.detail}`);
    return r;
  }
}

function describeJoseError(e: unknown): string {
  const err = e as { code?: string; claim?: string; reason?: string; message?: string };
  switch (err?.code) {
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (err.claim === 'iss') return 'issuer mismatch';
      if (err.claim === 'aud') return 'audience mismatch';
      return `${err.claim ?? 'claim'} ${err.reason ?? 'invalid'}`;
    case 'ERR_JWT_EXPIRED':
      return 'token expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'bad signature';
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'unknown signing key';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'algorithm not RS256';
    default:
      return err?.message ?? 'invalid token';
  }
}
