// In-process Wiring on core fakes + the real course engine, for server tests. No network, no keys.
import type { RunDeps } from '@crumple/core';
import {
  FAKE_ATTACKER, FAKE_OWNER, FAKE_PAYEE, FakeChain, FakeJev, FakeJudge, FakeMandateSource, FakeRatingWriter,
  FakeScreener, FakeSekisho, FakeSigner, FakeStepUp, FakeTripwire, GullibleDriver,
} from '@crumple/core';
import { runCar } from '@crumple/course';
import type { Wiring } from './wiring.js';

export function fakeWiring(): Wiring {
  const mandates = new FakeMandateSource();
  const jev = new FakeJev();
  const deps: Omit<RunDeps, 'emit'> = {
    mandates, ratings: new FakeRatingWriter(), screener: new FakeScreener(), stepUp: new FakeStepUp(true, 5), jev,
    tripwire: new FakeTripwire(jev), judge: new FakeJudge(jev), chain: new FakeChain(), signer: new FakeSigner(), sekisho: new FakeSekisho(mandates),
    driverFor: () => new GullibleDriver(),
  };
  return {
    deps,
    integrations: { llm: false, jev: false, intercepta: false, world: false, ens: false, fork: false },
    ownerAddress: FAKE_OWNER,
    runCar: (car, spec, d, track) => runCar(car, spec, d, { attacker: FAKE_ATTACKER, payee: FAKE_PAYEE }, track),
  };
}
