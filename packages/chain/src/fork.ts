// Spawns `anvil` forking Base mainnet at a pinned block, waits until it answers RPC, returns { rpcUrl, stop }.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { BASE_CHAIN_ID } from './usdc.js';

/**
 * Pinned Base block (2026-09-26, ~19:00 JST). Pinning makes anvil cache every fetched account/slot under
 * ~/.foundry/cache/rpc/base/<block>, so repeated runs put almost no load on the upstream RPC.
 * Override with FORK_BLOCK. Must be within the archive range of the RPC (Alchemy/QuickNode: full archive).
 */
export const DEFAULT_FORK_BLOCK = 51_813_000;

export interface StartForkOpts {
  /** Upstream Base RPC. Default process.env.BASE_RPC_URL. Never logged. */
  rpcUrl?: string;
  /** Block to pin. Default process.env.FORK_BLOCK, then DEFAULT_FORK_BLOCK. `'latest'` pins latest−16. */
  forkBlock?: number | string;
  port?: number; // default process.env.ANVIL_PORT ?? 8545, or a free port if `port: 0`
  chainId?: number; // default 8453
  anvilPath?: string; // default `anvil` on PATH (or process.env.ANVIL_PATH)
  /** Extra anvil args. */
  extraArgs?: string[];
  /** Print anvil's own output. Default false (only startup line + errors). */
  verbose?: boolean;
  /** Readiness timeout. Default 90 s (first sync of fork metadata can be slow on a cold RPC). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface ForkHandle {
  rpcUrl: string;
  port: number;
  forkBlock: number;
  chainId: number;
  pid: number;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

function redact(s: string, secret: string | undefined): string {
  return secret ? s.split(secret).join('<BASE_RPC_URL>') : s;
}

export async function resolveForkBlock(rpcUrl: string, forkBlock: number | string | undefined): Promise<number> {
  const raw = forkBlock ?? process.env.FORK_BLOCK;
  if (raw === undefined || raw === '' || raw === null) return DEFAULT_FORK_BLOCK;
  if (raw === 'latest') {
    const hex = await rpc<string>(rpcUrl, 'eth_blockNumber');
    return Number(BigInt(hex)) - 16; // a few blocks back: reorg-safe on Base's 2 s blocks
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`FORK_BLOCK must be a positive integer or 'latest', got "${raw}"`);
  return n;
}

export async function startFork(opts: StartForkOpts = {}): Promise<ForkHandle> {
  const rpcUrl = opts.rpcUrl ?? process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('startFork: BASE_RPC_URL is not set');
  const log = opts.log ?? ((l: string) => console.log(l));
  const chainId = opts.chainId ?? BASE_CHAIN_ID;
  const port = opts.port === 0 ? await freePort() : (opts.port ?? Number(process.env.ANVIL_PORT ?? 8545));
  const forkBlock = await resolveForkBlock(rpcUrl, opts.forkBlock);
  const anvil = opts.anvilPath ?? process.env.ANVIL_PATH ?? 'anvil';

  const args = [
    '--fork-url', rpcUrl,
    '--fork-block-number', String(forkBlock),
    '--chain-id', String(chainId),
    '--port', String(port),
    '--host', '0.0.0.0',
    // keep the upstream happy: anvil retries transient errors and paces itself; state is cached per pinned block
    '--retries', '5',
    '--timeout', '45000',
    ...(opts.extraArgs ?? []),
  ];

  log(`[chain] anvil: fork Base @ block ${forkBlock} (chainId ${chainId}) on :${port} — ${opts.forkBlock ?? process.env.FORK_BLOCK ? 'FORK_BLOCK' : 'DEFAULT_FORK_BLOCK'}`);

  const child: ChildProcess = spawn(anvil, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const state: { exited: { code: number | null; signal: string | null } | null; stderrTail: string } = { exited: null, stderrTail: '' };
  child.on('exit', (code, signal) => {
    state.exited = { code, signal };
  });
  child.stdout?.on('data', (d: Buffer) => {
    if (opts.verbose) process.stdout.write(redact(d.toString(), rpcUrl));
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = redact(d.toString(), rpcUrl);
    state.stderrTail = (state.stderrTail + s).slice(-2000);
    if (opts.verbose) process.stderr.write(s);
  });
  child.on('error', (e) => {
    state.stderrTail += `\nspawn error: ${e.message}`;
    state.exited = { code: -1, signal: null };
  });

  const localUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  // readiness: eth_chainId answers with our chain id AND the fork block is queryable
  for (;;) {
    if (state.exited) throw new Error(`anvil exited (code ${state.exited.code}, signal ${state.exited.signal}) before it was ready:\n${state.stderrTail}`);
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`anvil did not become ready within ${opts.timeoutMs ?? 90_000} ms:\n${state.stderrTail}`);
    }
    try {
      const cid = await rpc<string>(localUrl, 'eth_chainId');
      if (Number(BigInt(cid)) === chainId) {
        const bn = await rpc<string>(localUrl, 'eth_blockNumber');
        if (Number(BigInt(bn)) >= forkBlock) break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`[chain] anvil ready at ${localUrl}`);

  const stop = () =>
    new Promise<void>((resolve) => {
      if (state.exited || child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    });

  // don't leave anvil orphaned if the parent dies
  const onExit = () => child.kill('SIGTERM');
  process.once('exit', onExit);

  return { rpcUrl: localUrl, port, forkBlock, chainId, pid: child.pid ?? -1, stop: async () => { process.off('exit', onExit); await stop(); } };
}
