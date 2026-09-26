// Deploy Guard over HTTP: presets, LLM draft (+ preset fallback), static-only audit (no fork in tests), limits.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { GUARD_PRESETS } from '@crumple/guard';
import { buildApp } from './app.js';
import { MemoryStore } from './public.js';
import { fakeWiring } from './test-wiring.js';
import { cleanContract, closestPreset, draftContract } from './guard.js';

const DRAFTED = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TipJar {
    address public owner;
    constructor() { owner = msg.sender; }
    function tip() external payable {}
}`;

let base = ''; let close = async () => {};
const calls: { system: string; user: string }[] = [];
let llmOut: () => Promise<string> = async () => `Sure! Here it is:\n\`\`\`solidity\n${DRAFTED}\n\`\`\`\nLet me know if you need changes.`;
beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  const w = fakeWiring();
  w.draftLlm = async (system, user) => {
    calls.push({ system, user });
    return llmOut();
  };
  const app = await buildApp(w, new MemoryStore());
  await app.listen({ port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
});
afterAll(() => close());
const post = (p: string, body: unknown, ip: string) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

describe('guard API', () => {
  it('lists at least three presets', async () => {
    const { presets } = await (await fetch(`${base}/api/guard/presets`)).json();
    expect(presets.length).toBeGreaterThanOrEqual(3);
    expect(presets[0]).toMatchObject({ id: expect.any(String), title: expect.any(String), prompt: expect.any(String), source: expect.stringContaining('contract') });
  });

  it('drafts a contract with a neutral prompt, fences stripped and pragma forced', async () => {
    const r = await post('/api/guard/draft', { prompt: 'a tip jar for my stream' }, '20.0.0.1');
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.name).toBe('TipJar');
    expect(d.source).toContain('contract TipJar');
    expect(d.source).toContain('pragma solidity ^0.8.24;');
    expect(d.source).not.toContain('```');
    expect(d.source).not.toContain('Let me know');
    expect(d.preset).toBeUndefined();
    const last = calls.at(-1)!;
    expect(last.user).toContain('a tip jar for my stream');
    expect(`${last.system} ${last.user}`.toLowerCase()).not.toMatch(/vulnerab|exploit|insecure|backdoor/);
  });

  it('falls back to the closest preset on a refusal', async () => {
    llmOut = async () => "I'm sorry, I can't help with that.";
    try {
      const d = await (await post('/api/guard/draft', { prompt: 'a price oracle for my lending market' }, '20.0.0.2')).json();
      expect(d.source).toBe(GUARD_PRESETS.find((p) => p.id === 'naive-oracle')!.source);
      expect(d.source).toContain('contract');
      expect(d.preset).toBe(true);
      expect(d.name).toBe('LendingOracle');
    } finally {
      llmOut = async () => DRAFTED;
    }
  });

  it('falls back to a preset when the LLM throws (timeout)', async () => {
    llmOut = async () => { throw new Error('timeout'); };
    try {
      const d = await (await post('/api/guard/draft', { prompt: 'a reward token with a faucet' }, '20.0.0.3')).json();
      expect(d.source).toBe(GUARD_PRESETS.find((p) => p.id === 'faucet-token')!.source);
      expect(d.name).toBe('RewardToken');
      expect(d.preset).toBe(true);
    } finally {
      llmOut = async () => DRAFTED;
    }
  });

  it('rejects a draft with no prompt or an oversized prompt', async () => {
    expect((await post('/api/guard/draft', {}, '20.0.0.4')).status).toBe(400);
    expect((await post('/api/guard/draft', { prompt: '   ' }, '20.0.0.4')).status).toBe(400);
    expect((await post('/api/guard/draft', { prompt: 'x'.repeat(601) }, '20.0.0.4')).status).toBe(400);
  });

  it('audits a public mint contract as VULNERABLE with unprotected-mint', async () => {
    const mint = GUARD_PRESETS.find((p) => p.id === 'faucet-token')!.source;
    const r = await post('/api/guard/audit', { source: mint }, '20.0.0.5');
    expect(r.status).toBe(200);
    const { report } = await r.json();
    expect(report.verdict).toBe('VULNERABLE');
    expect(report.findings.map((f: { id: string }) => f.id)).toContain('unprotected-mint');
  });

  it('rejects an empty or oversized source without spending the cooldown', async () => {
    expect((await post('/api/guard/audit', {}, '20.0.0.6')).status).toBe(400);
    expect((await post('/api/guard/audit', { source: 'x'.repeat(12 * 1024 + 1) }, '20.0.0.6')).status).toBe(400);
    const ok = await post('/api/guard/audit', { source: GUARD_PRESETS[0]!.source }, '20.0.0.6');
    expect(ok.status).toBe(200);
  });

  it('never 500s on garbage Solidity', async () => {
    const r = await post('/api/guard/audit', { source: 'this is not solidity {{{' }, '20.0.0.7');
    expect(r.status).toBe(200);
    const { report } = await r.json();
    expect(['VULNERABLE', 'SAFE', 'COMPILE_ERROR']).toContain(report.verdict);
  });

  it('rate-limits audits to one per 8s per client', async () => {
    const src = GUARD_PRESETS[0]!.source;
    expect((await post('/api/guard/audit', { source: src }, '20.0.0.8')).status).toBe(200);
    const again = await post('/api/guard/audit', { source: src }, '20.0.0.8');
    expect(again.status).toBe(429);
    expect((await again.json()).error).toMatch(/One audit per 8s/);
  });

  it('picks up a guard fork that comes up after boot, and still answers when that fork is unreachable', async () => {
    const w = fakeWiring();
    const app = await buildApp(w, new MemoryStore());
    await app.listen({ port: 0 });
    try {
      w.guardRpcUrl = 'http://127.0.0.1:1'; // set after buildApp, as wire.ts does once the dedicated fork is ready
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/guard/audit`;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: GUARD_PRESETS.find((p) => p.id === 'faucet-token')!.source }) });
      expect(r.status).toBe(200);
      const { report } = await r.json();
      expect(report.findings.map((f: { id: string }) => f.id)).toContain('unprotected-mint');
    } finally {
      await app.close();
    }
  });

  it('allows at most 20 drafts a minute across all clients', async () => {
    const app = await buildApp(fakeWiring(), new MemoryStore());
    await app.listen({ port: 0 });
    try {
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/guard/draft`;
      const statuses: number[] = [];
      for (let i = 1; i <= 21; i++) {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.8.0.${i}` }, body: JSON.stringify({ prompt: 'a vault' }) });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(statuses[20]).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe('cleanContract / closestPreset', () => {
  it('rejects prose, imports and truncated output', () => {
    expect(cleanContract('I cannot help with that.')).toBeNull();
    expect(cleanContract(`pragma solidity ^0.8.24;\nimport "./x.sol";\ncontract A {}`)).toBeNull();
    expect(cleanContract(`pragma solidity ^0.8.24;\ncontract A {\n  function f() external {\n`)).toBeNull();
    expect(cleanContract(`pragma solidity ^0.8.24;\ninterface I { function f() external; }`)).toBeNull();
  });
  it('never takes a word from a comment as the contract (name or existence)', async () => {
    expect(cleanContract(`// A simple contract for tipping\npragma solidity ^0.8.24;\ninterface I { function f() external; }`)).toBeNull();
    const d = await draftContract('a tip jar', async () => `// SPDX-License-Identifier: MIT\n// A simple contract for tipping\npragma solidity ^0.8.24;\n/* contract Old */\ncontract TipJar {\n    function tip() external payable {}\n}`);
    expect(d.name).toBe('TipJar');
    expect(d.preset).toBeUndefined();
    expect(await draftContract('a tip jar')).toMatchObject({ preset: true }); // no LLM configured
  });
  it('picks the preset sharing the most words, else the first', () => {
    expect(closestPreset('only the owner can withdraw from my USDC vault').id).toBe('safe-vault');
    expect(closestPreset('zzz qqq').id).toBe(GUARD_PRESETS[0]!.id);
  });
});
