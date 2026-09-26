// Builds the real implementation of every port when its env is present, the core fake otherwise.
// `integrations` reports which is which so the arena can show "offline" pills (CONTRACT Rule 7).
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FakeChain, FakeMandateSource, FakeRatingWriter, WEATHER_PAYEE_ENS, jevConfig, llmConfig,
  type Chain, type Integrations, type MandateSource, type RatingWriter,
} from '@crumple/core';
import { createSekisho, createSigner, llmFromEnv } from '@crumple/sekisho';
import { createScreener, ATTACKERS, WEATHER } from '@crumple/intercepta';
import { createStepUp, isLive as worldLive } from '@crumple/world';
import { createChain, startFork, paymentRequiredBody, paymentRequirements, type ForkHandle } from '@crumple/chain';
import { createJev, JevJudge, JevTripwire, driverFor, runCar } from '@crumple/course';
import type { Wiring } from './wiring.js';

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
    mandates.names.set(WEATHER_PAYEE_ENS, WEATHER);
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

export async function createWiring(): Promise<Wiring> {
  process.env.WEATHER_ADDRESS ??= WEATHER;
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
  const addrs = { attacker: ATTACKERS[0], attacker2: ATTACKERS[1], weather: WEATHER };

  return {
    deps: { mandates, ratings, screener, stepUp, jev, tripwire, judge, chain, signer, sekisho, driverFor: (car, spec) => driverFor(car, spec) },
    integrations,
    ownerAddress,
    runCar: (car, spec, deps) => runCar(car, spec, deps, addrs),
    async mountX402(app) {
      // A real x402 resource so connected agents can hit the same seller the course simulates.
      app.get('/x402/weather/report', async (req, reply) => {
        const resource = `${process.env.PUBLIC_URL ?? ''}/x402/weather/report`;
        return reply
          .code(402)
          .send(paymentRequiredBody(paymentRequirements({ payTo: WEATHER, priceUsd: 1, resource, description: "Today's Tokyo weather report" })));
      });
    },
    async close() {
      await fork?.stop();
    },
  };
}
