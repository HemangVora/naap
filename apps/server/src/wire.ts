// Builds the real implementation of every port when its env is present, the core fake otherwise.
// `integrations` reports which is which so the arena can show "offline" pills (CONTRACT Rule 7).
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FakeChain, FakeMandateSource, FakeRatingWriter, PAYEE_ENS, jevConfig, llmConfig,
  type Address, type Chain, type Integrations, type MandateSource, type RatingWriter,
} from '@crumple/core';
import { createSekisho, createSigner, llmFromEnv } from '@crumple/sekisho';
import { createScreener, ATTACKERS, PAYEE } from '@crumple/intercepta';
import { createStepUp, isLive as worldLive } from '@crumple/world';
import { createChain, startFork, paymentRequiredBody, paymentRequirements, type ForkHandle } from '@crumple/chain';
import { createJev, JevJudge, JevTripwire, driverFor, runCar } from '@crumple/course';
import Anthropic from '@anthropic-ai/sdk';
import type { EnsMandateSource } from '@crumple/ens';
import type { DraftLlm } from './incidents.js';
import type { IncidentsEns, Wiring } from './wiring.js';

/** The incident + Deploy Guard contract drafter: Claude Haiku, one plain-text turn, 20 s. Same client construction as report.ts. */
const DRAFT_MODEL = 'claude-haiku-4-5-20251001';
const DRAFT_TIMEOUT_MS = 20_000;

function draftLlmFromEnv(): DraftLlm | undefined {
  const cfg = llmConfig();
  if (cfg.provider === 'none') return undefined;
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0 });
  const model = cfg.model(DRAFT_MODEL);
  return async (system, user) => {
    const res = await client.messages.create(
      { model, max_tokens: 1600, system, messages: [{ role: 'user', content: user }] },
      { timeout: DRAFT_TIMEOUT_MS, maxRetries: 0 },
    );
    return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  };
}

/** Only the real ENS lane can register subnames; the fake and local sources have no such methods, so incidents stay off-chain there. */
function incidentsEnsFrom(mandates: MandateSource, owner: Address): IncidentsEns | undefined {
  const m = mandates as Partial<EnsMandateSource>;
  if (typeof m.registerSubname !== 'function' || typeof m.writeText !== 'function') return undefined;
  const ens = mandates as EnsMandateSource;
  return {
    register: (label) => ens.registerSubname(label, owner),
    writeText: (ensName, records) => ens.writeText(ensName, records),
  };
}

const log = (l: string) => console.error(`[wire] ${l}`);

async function mandatesAndRatings(): Promise<{ mandates: MandateSource; ratings: RatingWriter; live: boolean }> {
  try {
    const ens = await import('@crumple/ens');
    const mandates = await ens.createMandateSource({ log });
    const ratings = ens.createRatingWriter(mandates);
    const live = (mandates as { live?: boolean; kind?: string }).live ?? process.env.ENS_MODE === 'ens';
    return { mandates, ratings, live };
  } catch (err) {
    log(`ENS lane unavailable, using fakes: ${(err as Error).message}`);
    const mandates = new FakeMandateSource();
    mandates.names.set(PAYEE_ENS, PAYEE);
    return { mandates, ratings: new FakeRatingWriter(), live: false };
  }
}

async function chainOrFake(): Promise<{ chain: Chain; fork?: ForkHandle; live: boolean }> {
  if (!process.env.BASE_RPC_URL) {
    log('BASE_RPC_URL missing → FakeChain');
    return { chain: new FakeChain(), live: false };
  }
  const fork = await startFork({});
  log(`fork up at block ${fork.forkBlock}`);
  return { chain: createChain({ rpcUrl: fork.rpcUrl, log }), fork, live: true };
}

/**
 * Deploy Guard's own anvil fork, started in the background so it never delays or fails boot. Its per-audit
 * evm_snapshot/evm_revert must not touch the car fork. Resolves undefined when there is no upstream or it fails to start.
 */
function startGuardFork(onReady: (rpcUrl: string) => void): Promise<ForkHandle | undefined> {
  if (!process.env.BASE_RPC_URL) {
    log('BASE_RPC_URL missing → Deploy Guard is static-only (no sandbox deploy, no proof tx)');
    return Promise.resolve(undefined);
  }
  return startFork({ port: 0, log }).then(
    (f) => {
      log(`guard fork up at ${f.rpcUrl}`);
      onReady(f.rpcUrl);
      return f;
    },
    (e) => {
      log(`guard fork failed to start, Deploy Guard is static-only: ${(e as Error).message}`);
      return undefined;
    },
  );
}

export async function createWiring(): Promise<Wiring> {
  process.env.PAYEE_ADDRESS ??= PAYEE;
  // Fail closed: a guessable seed means guessable car keys. Only local development may fall back.
  const seed = process.env.SIGNER_SEED || (process.env.NODE_ENV === 'development' ? 'crumple-dev-signer-seed' : '');
  if (!seed) throw new Error('SIGNER_SEED is required outside NODE_ENV=development');
  const ownerAddress = privateKeyToAccount(keccak256(toHex(`owner:${seed}`))).address;

  const [{ mandates, ratings, live: ensLive }, { chain, fork, live: forkLive }] = await Promise.all([mandatesAndRatings(), chainOrFake()]);
  const screener = createScreener();
  const jev = createJev();
  const tripwire = new JevTripwire(jev);
  const judge = new JevJudge(jev);
  const stepUp = createStepUp();
  const signer = createSigner({ seed });
  const sekisho = createSekisho({ mandates, screener, tripwire, llm: llmFromEnv() });

  const integrations: Integrations = {
    llm: llmConfig().provider !== 'none',
    jev: jevConfig().provider !== 'none',
    intercepta: !!process.env.INTERCEPTA_API_KEY,
    world: worldLive(),
    ens: ensLive,
    fork: forkLive,
  };
  const addrs = { attacker: ATTACKERS[0], attacker2: ATTACKERS[1], payee: PAYEE };

  const wiring: Wiring = {
    deps: { mandates, ratings, screener, stepUp, jev, tripwire, judge, chain, signer, sekisho, driverFor: (car, spec) => driverFor(car, spec) },
    integrations,
    ownerAddress,
    runCar: (car, spec, deps, track) => runCar(car, spec, deps, addrs, track),
    incidentsEns: incidentsEnsFrom(mandates, ownerAddress),
    draftLlm: draftLlmFromEnv(),
    async mountX402(app) {
      // A real x402 resource so connected agents can hit the same seller the course simulates.
      // /x402/weather/report is the pre-rename path, kept as an alias so older agents still get the same 402.
      const resource = `${process.env.PUBLIC_URL ?? ''}/x402/compute/inference`;
      for (const path of ['/x402/compute/inference', '/x402/weather/report']) {
        app.get(path, async (_req, reply) =>
          reply
            .code(402)
            .send(paymentRequiredBody(paymentRequirements({ payTo: PAYEE, priceUsd: 1, resource, description: '1 hour of GPU inference (1× H100)' }))),
        );
      }
    },
    async close() {
      await Promise.all([fork?.stop(), guardFork.then((g) => g?.stop())]);
    },
  };
  const guardFork = startGuardFork((rpcUrl) => {
    wiring.guardRpcUrl = rpcUrl;
  });
  return wiring;
}
