import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Car, Observation } from '@crumple/core';
import { FAKE_ATTACKER } from '@crumple/core';
import { assertPublicUrl, WebhookDriver } from './webhook.js';
import { sanitiseActions } from './sanitize.js';
import { driverFor, OfflineGullibleDriver, ClaudeDriver } from './index.js';

const obs: Observation = { runId: 'r', barrierId: 'legit', ownerRequest: 'x', content: [], tools: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('assertPublicUrl', () => {
  it.each([
    'http://localhost:3000/hook',
    'http://foo.localhost/hook',
    'http://127.0.0.1/hook',
    'http://127.1.2.3/hook',
    'http://10.0.0.1/hook',
    'http://172.16.5.5/hook',
    'http://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/hook',
    'http://0.0.0.0/hook',
    'http://2130706433/hook', // decimal 127.0.0.1
    'http://[::1]/hook',
    'http://[fd00::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://agent.internal/hook',
    'ftp://example.com/hook',
    'http://user:pw@example.com/hook',
    'not a url',
  ])('rejects %s', (u) => {
    expect(() => assertPublicUrl(u, false)).toThrow();
  });

  it('accepts public http(s)', () => {
    expect(assertPublicUrl('https://agent.example.com/hook', false).hostname).toBe('agent.example.com');
    expect(assertPublicUrl('http://93.184.216.34/hook', false).hostname).toBe('93.184.216.34');
  });

  it('allows loopback only in development', () => {
    expect(() => assertPublicUrl('http://localhost:3000/hook', true)).not.toThrow();
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => assertPublicUrl('http://localhost:3000/hook')).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertPublicUrl('http://localhost:3000/hook')).toThrow(/private or loopback/);
  });
});

describe('WebhookDriver', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('times out after the configured window', async () => {
    const fetch = vi.fn((_: string, init: RequestInit) =>
      new Promise<Response>((_, rej) => {
        init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      }),
    );
    const d = new WebhookDriver('https://agent.example.com/hook', { fetch, timeoutMs: 30 });
    await expect(d.act(obs)).rejects.toThrow(/no response within 30 ms/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('posts the observation and sanitises the actions', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://agent.example.com/hook');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toMatchObject({ runId: 'r', barrierId: 'legit' });
      return jsonResponse({
        actions: [
          { type: 'pay', args: { payTo: FAKE_ATTACKER, amountUsd: '5.005', token: 'WAT', memo: 123 } },
          { type: 'pay', args: { payTo: 'not-an-address', amountUsd: 1, token: 'USDC', memo: '' } },
          { type: 'pay', args: { payTo: 'Weather.Crumple.ETH', amountUsd: -1 } },
          { type: 'hack', args: {} },
          { type: 'reply', text: 'hi\u0000there' },
          { type: 'noop' },
        ],
      });
    });
    const d = new WebhookDriver('https://agent.example.com/hook', { fetch });
    const actions = await d.act(obs);
    expect(actions).toEqual([
      { type: 'pay', args: { payTo: FAKE_ATTACKER, amountUsd: 5.01, token: 'USDC', memo: '' } },
      { type: 'reply', text: 'hithere' },
      { type: 'noop' },
    ]);
  });

  it('caps the action count and rejects non-JSON / non-2xx', async () => {
    const many = { actions: Array.from({ length: 20 }, () => ({ type: 'noop' })) };
    expect(sanitiseActions(many)).toHaveLength(8);
    expect(sanitiseActions([{ type: 'reply', text: 'x' }])).toHaveLength(1);
    expect(sanitiseActions('nope')).toEqual([]);

    const bad = new WebhookDriver('https://agent.example.com/hook', { fetch: async () => jsonResponse('<html>') });
    await expect(bad.act(obs)).rejects.toThrow(/not JSON/);
    const down = new WebhookDriver('https://agent.example.com/hook', { fetch: async () => jsonResponse({ actions: [] }, 503) });
    await expect(down.act(obs)).rejects.toThrow(/HTTP 503/);
  });

  it('turns an empty list into a noop', async () => {
    const d = new WebhookDriver('https://agent.example.com/hook', { fetch: async () => jsonResponse({ actions: [{ type: 'pay', args: {} }] }) });
    expect(await d.act(obs)).toEqual([{ type: 'noop', reason: 'webhook returned no valid actions' }]);
  });
});

describe('driverFor', () => {
  const car: Car = { id: 'c1', spec: { kind: 'built', name: 'c', color: '#fff' }, ensName: 'c1.crumple.eth', wallet: FAKE_ATTACKER, createdAt: 0, sessionToken: 's' };

  it('falls back to the offline GullibleDriver without an Anthropic key', () => {
    const d = driverFor(car, { kind: 'built', name: 'c', color: '#fff', persona: 'chill' }, {});
    expect(d).toBeInstanceOf(OfflineGullibleDriver);
    expect(d.offline).toBe(true);
    expect(d.kind).toBe('gullible');
  });

  it('builds a ClaudeDriver when a key is present (no network at construction)', () => {
    const d = driverFor(car, { kind: 'built', name: 'c', color: '#fff', model: 'claude-sonnet-5' }, { ANTHROPIC_API_KEY: 'sk-test' });
    expect(d).toBeInstanceOf(ClaudeDriver);
    expect(d.offline).toBe(false);
    expect((d as ClaudeDriver).model).toBe('claude-sonnet-5');
    expect((d as ClaudeDriver).provider).toBe('anthropic');
    expect((d as ClaudeDriver).providerModel).toBe('claude-sonnet-5');
  });

  it('routes through OpenRouter with mapped model ids when only OPENROUTER_API_KEY is set', () => {
    const d = driverFor(car, { kind: 'built', name: 'c', color: '#fff' }, { OPENROUTER_API_KEY: 'or-test' }) as ClaudeDriver;
    expect(d).toBeInstanceOf(ClaudeDriver);
    expect(d.provider).toBe('openrouter');
    expect(d.model).toBe('claude-haiku-4-5-20251001');
    expect(d.providerModel).toBe('anthropic/claude-haiku-4.5');
  });

  it('refuses connected cars with private endpoints or missing fields', () => {
    expect(() => driverFor(car, { kind: 'webhook', name: 'c', color: '#fff', endpoint: 'http://127.0.0.1:8080/x' }, {})).toThrow(/private or loopback/);
    expect(() => driverFor(car, { kind: 'webhook', name: 'c', color: '#fff' }, {})).toThrow(/no endpoint/);
    expect(() => driverFor(car, { kind: 'openai', name: 'c', color: '#fff', endpoint: 'https://api.example.com/v1' }, {})).toThrow(/needs endpoint, model and key/);
    const ok = driverFor(car, { kind: 'openai', name: 'c', color: '#fff', endpoint: 'https://api.example.com/v1', openaiModel: 'gpt-x', openaiApiKey: 'k' }, {});
    expect(ok.kind).toBe('openai');
  });
});
