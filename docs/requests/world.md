# Requests from lane world (integrator decides; nothing blocks)

1. **Offline pill for World.** `StepUp` has no `live` flag and `stepup.pending` only carries `canApprove`. `@crumple/world` exports `isLive()` and `createStepUp().live`. Suggest the server passes `stepUp.live` into whatever powers the "offline" pills (e.g. in `hello` or a `stepup.pending.live?: boolean`), so the projector says "World offline" when `FakeStepUp` is standing in (CONTRACT Rule 7).
   Workaround in place: `createStepUp()` logs `[world] OFFLINE …` once at boot.

2. **FakeStepUp EXPIRED wording.** `fakes.ts` says `no owner approval within 60s`; the contract and the live lane say `No owner step-up within 60 s — payment refused`. Align the fake if the web lane matches on the string; otherwise ignore.

3. **Wiring.** `import { createStepUp } from '@crumple/world'` → `deps.stepUp = createStepUp()` (reads `WORLD_ISSUER`, `WORLD_CLIENT_ID`, `WORLD_CLIENT_SECRET`, optional `WORLD_CLIENT_AUTH`). It never throws from `request()`; a grant that fails to start resolves `EXPIRED` with the reason in `detail`.

4. **.env.example** (root, not ours): add `WORLD_CLIENT_AUTH=client_secret_post` next to the other `WORLD_*` vars.
