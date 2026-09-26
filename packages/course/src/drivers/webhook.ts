// Connected car via webhook: POST the Observation, expect `{ actions: AgentAction[] }`.
// 10 s timeout, response capped, every action sanitised, private/loopback targets refused (SSRF).
import type { AgentAction, Observation } from '@crumple/core';
import { REMOTE_STEP_TIMEOUT_MS } from '@crumple/core';
import type { CourseDriver } from './types.js';
import { sanitiseActions } from './sanitize.js';

export const MAX_RESPONSE_BYTES = 64 * 1024;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface WebhookOptions {
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Overrides the NODE_ENV check (tests). */
  allowPrivate?: boolean;
}

function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6Private(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return ipv4Private(mapped[1]!);
  return false;
}

/** Throws on anything that is not a public http(s) URL. Set NODE_ENV=development to allow localhost. */
export function assertPublicUrl(endpoint: string, allowPrivate = process.env.NODE_ENV === 'development'): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('webhook: invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('webhook: only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('webhook: credentials in URL are not allowed');
  if (allowPrivate) return url;
  const host = url.hostname.toLowerCase();
  const bad =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    ipv4Private(host) ||
    host.startsWith('[') ||
    host.includes(':') && ipv6Private(host);
  if (bad) throw new Error(`webhook: private or loopback host "${host}" refused`);
  return url;
}

export class WebhookDriver implements CourseDriver {
  readonly kind = 'webhook' as const;
  readonly offline = false;
  readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(endpoint: string, opts: WebhookOptions = {}) {
    this.endpoint = assertPublicUrl(endpoint, opts.allowPrivate).toString();
    this.timeoutMs = opts.timeoutMs ?? REMOTE_STEP_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async act(obs: Observation): Promise<AgentAction[]> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'naap-course/0.1' },
        body: JSON.stringify(obs),
        signal,
        redirect: 'error',
      });
    } catch (e) {
      if (signal.aborted || (e as { name?: string })?.name === 'TimeoutError' || (e as { name?: string })?.name === 'AbortError') {
        throw new Error(`webhook: no response within ${this.timeoutMs} ms`);
      }
      throw new Error(`webhook: request failed (${(e as Error)?.message ?? 'unknown'})`);
    }
    if (!res.ok) throw new Error(`webhook: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('webhook: response too large');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('webhook: response is not JSON');
    }
    const actions = sanitiseActions(json);
    return actions.length ? actions : [{ type: 'noop', reason: 'webhook returned no valid actions' }];
  }
}
