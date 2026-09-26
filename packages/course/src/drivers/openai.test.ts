import { describe, expect, it, vi } from 'vitest';
import type { Observation } from '@crumple/core';
import { FAKE_PAYEE } from '@crumple/core';
import { OpenAICompatDriver } from './openai.js';
import { PAY_TOOL } from '../barriers.js';

const obs: Observation = { runId: 'r', barrierId: 'legit', ownerRequest: 'buy compute', content: [{ kind: 'http402', source: 's', text: '402' }], tools: [PAY_TOOL] };
const KEY = 'sk-super-secret-key-123';

function completion(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('OpenAICompatDriver', () => {
  it('sends chat completions with the pay tool and parses tool_calls', async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push({ url: String(input), auth: headers.get('authorization'), body: String(init?.body) });
      return completion({
        id: 'x', object: 'chat.completion', created: 0, model: 'gpt-x',
        choices: [{
          index: 0, finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: 'Paying now.',
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'pay', arguments: JSON.stringify({ payTo: FAKE_PAYEE, amountUsd: 1, token: 'USDC', memo: 'report' }) } },
              { id: 't2', type: 'function', function: { name: 'pay', arguments: '{not json' } },
              { id: 't3', type: 'function', function: { name: 'other', arguments: '{}' } },
            ],
          },
        }],
      });
    });
    const d = new OpenAICompatDriver('https://llm.example.com/v1', 'gpt-x', KEY, { fetch: fetchMock as unknown as typeof fetch });
    const actions = await d.act(obs);
    expect(actions).toEqual([
      { type: 'reply', text: 'Paying now.' },
      { type: 'pay', args: { payTo: FAKE_PAYEE, amountUsd: 1, token: 'USDC', memo: 'report' } },
    ]);
    expect(seen[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(seen[0]!.body) as { tools: { function: { name: string } }[]; model: string };
    expect(body.model).toBe('gpt-x');
    expect(body.tools[0]!.function.name).toBe('pay');
  });

  it('never leaks the key in errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401 }));
    const d = new OpenAICompatDriver('https://llm.example.com/v1', 'gpt-x', KEY, { fetch: fetchMock as unknown as typeof fetch });
    let msg = '';
    try {
      await d.act(obs);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^openai: /);
    expect(msg).not.toContain(KEY);
  });

  it('refuses private base URLs', () => {
    expect(() => new OpenAICompatDriver('http://localhost:11434/v1', 'llama', KEY)).toThrow(/private or loopback/);
  });
});
