// World ID for Agents (sandbox.auth.world.org) — OIDC device-authorization grant client.
// Backend only. Never log the client secret, device codes, or tokens in full.
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export const DEFAULT_ISSUER = 'https://sandbox.auth.world.org';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export type ClientAuthMethod = 'client_secret_post' | 'client_secret_basic';

export interface Discovery {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number; // seconds (sandbox: 1200)
  interval?: number; // seconds (default 5 per RFC 8628)
}

export type TokenPoll =
  | { kind: 'token'; id_token: string }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'denied' }
  | { kind: 'expired'; error: string }
  | { kind: 'error'; error: string; status: number };

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authMethod?: ClientAuthMethod;
  fetch?: typeof fetch;
  /** Test hook: replaces the remote JWKS resolver. */
  getKey?: JWTVerifyGetKey;
  /** Per-request HTTP timeout. */
  timeoutMs?: number;
  /** Clock (ms) used for exp/iat checks; defaults to Date.now. */
  now?: () => number;
}

export class OidcError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = 'OidcError';
  }
}

/** Thin, dependency-free client for the three calls the device grant needs. */
export class WorldOidcClient {
  private discovery?: Promise<Discovery>;
  private getKey?: JWTVerifyGetKey;
  private readonly fetchImpl: typeof fetch;
  private readonly authMethod: ClientAuthMethod;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: OidcClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.authMethod = opts.authMethod ?? 'client_secret_post';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.getKey = opts.getKey;
  }

  get issuer() {
    return this.opts.issuer.replace(/\/$/, '');
  }

  async discover(): Promise<Discovery> {
    if (!this.discovery) {
      this.discovery = this.fetchDiscovery().catch((e) => {
        this.discovery = undefined; // retry next time
        throw e;
      });
    }
    return this.discovery;
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const res = await this.http(`${this.issuer}/.well-known/openid-configuration`, { method: 'GET' });
    if (!res.ok) throw new OidcError(`discovery failed (HTTP ${res.status})`, res.status);
    const d = (await res.json()) as Partial<Discovery>;
    if (!d.issuer || !d.device_authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
      throw new OidcError('discovery document is missing device/token/jwks endpoints');
    }
    if (d.issuer.replace(/\/$/, '') !== this.issuer) {
      throw new OidcError(`discovery issuer mismatch: expected ${this.issuer}, got ${d.issuer}`);
    }
    return d as Discovery;
  }

  /** RFC 8628 §3.1 — start a device authorization. Scope is exactly `openid` (the only one World supports). */
  async deviceAuthorization(): Promise<DeviceAuthorization> {
    const d = await this.discover();
    const res = await this.form(d.device_authorization_endpoint, { scope: 'openid' });
    const body = await readJson(res);
    if (!res.ok) {
      const retry = res.headers.get('retry-after');
      const code = String(body?.error ?? `http_${res.status}`);
      const hint = code === 'invalid_client' ? ' (check WORLD_CLIENT_ID/SECRET and WORLD_CLIENT_AUTH match the portal registration)' : '';
      throw new OidcError(`device authorization refused: ${code}${retry ? `, retry after ${retry}s` : ''}${hint}`, res.status, code);
    }
    const da = body as Partial<DeviceAuthorization>;
    if (!da.device_code || !da.user_code || !da.verification_uri || typeof da.expires_in !== 'number') {
      throw new OidcError('device authorization response is missing required fields');
    }
    return da as DeviceAuthorization;
  }

  /** One poll of the token endpoint. Never throws on OAuth errors — returns a classified result. */
  async pollToken(deviceCode: string): Promise<TokenPoll> {
    const d = await this.discover();
    let res: Response;
    try {
      res = await this.form(d.token_endpoint, { grant_type: DEVICE_GRANT, device_code: deviceCode });
    } catch (e) {
      return { kind: 'error', error: `network: ${(e as Error).message}`, status: 0 };
    }
    const body = await readJson(res);
    if (res.ok) {
      if (typeof body?.id_token !== 'string') return { kind: 'error', error: 'token response has no id_token', status: res.status };
      return { kind: 'token', id_token: body.id_token };
    }
    const error = String(body?.error ?? `http_${res.status}`);
    switch (error) {
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slow_down' };
      case 'access_denied':
        return { kind: 'denied' };
      case 'expired_token':
      case 'invalid_grant':
        return { kind: 'expired', error };
      default:
        return { kind: 'error', error, status: res.status };
    }
  }

  /** Validates an ID token: RS256 via JWKS, exact iss, aud = clientId, exp (jose), then returns the payload. */
  async verifyIdToken(idToken: string): Promise<JWTPayload & { auth_time?: number; acr?: string; amr?: string[] }> {
    const getKey = await this.keyResolver();
    const { payload } = await jwtVerify(idToken, getKey, {
      issuer: this.issuer,
      audience: this.opts.clientId,
      algorithms: ['RS256'],
      clockTolerance: 30,
      currentDate: new Date(this.now()),
      requiredClaims: ['sub', 'exp', 'iat', 'auth_time'],
    });
    return payload as JWTPayload & { auth_time?: number; acr?: string; amr?: string[] };
  }

  private async keyResolver(): Promise<JWTVerifyGetKey> {
    if (this.getKey) return this.getKey;
    const d = await this.discover();
    this.getKey = createRemoteJWKSet(new URL(d.jwks_uri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    return this.getKey;
  }

  private form(url: string, fields: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams(fields);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.authMethod === 'client_secret_basic') {
      const cred = Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString('base64');
      headers.authorization = `Basic ${cred}`;
      body.set('client_id', this.opts.clientId);
    } else {
      body.set('client_id', this.opts.clientId);
      body.set('client_secret', this.opts.clientSecret);
    }
    return this.http(url, { method: 'POST', headers, body: body.toString() });
  }

  private async http(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** "0x12ab…cd34"-style truncation for subjects shown on screen. */
export function shortSub(sub: string): string {
  if (sub.length <= 12) return sub;
  return `${sub.slice(0, 6)}…${sub.slice(-4)}`;
}
