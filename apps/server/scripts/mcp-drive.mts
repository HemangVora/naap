// Drive one car through a running NaAP server over MCP with scripted answers (a naive agent):
// pays every 402 it sees at legit / x402-swap / over-limit, does nothing on grok-morse / freysa.
//   pnpm --filter @crumple/server exec tsx scripts/mcp-drive.mts http://localhost:8788 [name]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const name = process.argv[3] ?? 'MCP Script';
const j = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0].text);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
let carId = '';
ws.onmessage = (m) => {
  const e = JSON.parse(String(m.data));
  if (e.t === 'car.joined' && e.car.id === carId) log('ws car.joined', e.car.kind, e.car.name);
  if ('carId' in e && e.carId === carId && ['barrier.enter', 'barrier.result', 'stepup.pending', 'stepup.resolved', 'run.finished', 'rating', 'rating.onchain'].includes(e.t))
    log('ws', e.t, e.t === 'barrier.result' ? `${e.result.variant} ${e.result.barrierId} → ${e.result.outcome} $${e.result.lossUsd} ${e.result.reason} ${e.result.blockedBy.join(',')}` : e.variant ?? e.barrierId ?? '', e.t === 'rating' ? JSON.stringify(e.rating) : '');
};

const client = new Client({ name: 'naap-scripted-agent', version: '0.0.1' });
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
await client.connect(transport);
log('connected, session', transport.sessionId);
const entered = j(await client.callTool({ name: 'naap_enter_track', arguments: { name, color: '#ff7ac8' } }));
carId = entered.carId;
log('entered', entered.carId, entered.carUrl);

for (let i = 0; i < 60; i++) {
  const n = j(await client.callTool({ name: 'naap_next_barrier', arguments: {} }));
  if (n.status === 'waiting') { log('waiting…'); continue; }
  if (n.status === 'finished') { log('finished', JSON.stringify(n.rating)); break; }
  log(`barrier ${n.step} ${n.barrierId}: "${n.ownerRequest}" (${n.content.length} items)`);
  const text = n.content.map((c: { text: string }) => c.text).join('\n');
  const m402 = text.match(/"payTo":\s*"(0x[0-9a-fA-F]{40})"[\s\S]*?"maxAmountRequired":\s*"(\d+)"/) ?? text.match(/"maxAmountRequired":\s*"(\d+)"[\s\S]*?"payTo":\s*"(0x[0-9a-fA-F]{40})"/);
  if (m402 && /402/.test(text)) {
    const payTo = m402[1].startsWith('0x') ? m402[1] : m402[2];
    const amountUsd = Number(m402[1].startsWith('0x') ? m402[2] : m402[1]) / 1e6;
    const r = j(await client.callTool({ name: 'naap_pay', arguments: { payTo, amountUsd, memo: 'weather report' } }));
    log(`  pay $${amountUsd} → ${payTo} (recorded ${r.recorded})`);
  } else log('  no payment request found → done');
  await client.callTool({ name: 'naap_done', arguments: { reply: `scripted agent handled ${n.barrierId}` } });
}
const rating = j(await client.callTool({ name: 'naap_rating', arguments: {} }));
log('rating tool', JSON.stringify(rating.rating), rating.barriers.map((b: { barrierId: string; bare: { outcome: string } | null; airbag: { outcome: string } | null }) => `${b.barrierId}: ${b.bare?.outcome}/${b.airbag?.outcome}`).join(' · '));
await new Promise((r) => setTimeout(r, 1500));
await transport.terminateSession();
await client.close();
ws.close();
