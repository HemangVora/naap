# Request from lane ens-rename → integrator

ENS parent is now `naap.eth` (live on ENSv2 Sepolia, see `docs/lanes/ens.md`). `PARENT_ENS` / `PAYEE_ENS` in
`@crumple/core` default to `naap.eth` / `compute.naap.eth`; `ENS_PARENT=<label>.eth` overrides server-side (browsers always
get the default). Rating text records are now `naap.*` (were `crumple.*`).

**Restart the :8787 server** to pick it up: the running process still resolves `crumple.eth` (it discovered the
layout at boot). Nothing else to set: `.env` has no `ENS_USER_REGISTRY`/`ENS_RESOLVER` overrides.

## Hard-coded `crumple.eth` left in files owned by other lanes (not edited)

Prefer `car.ensName` from the server, or import `PARENT_ENS` / `PAYEE_ENS` from `@crumple/core`.

| File | Line | String |
|---|---|---|
| `apps/web/src/arena/hall.ts` | 18 | `'compute.crumple.eth · $1.00'` |
| `apps/web/src/arena/index.ts` | 205, 360 | `` `${id}.crumple.eth` ``, `` `Paid … · compute.crumple.eth` `` |

`hud.ts`, `store.ts`, `mock-feed.ts` were already switched to literal `naap.eth` by their owning lane (01:35 JST); they
still hard-code it rather than import `PARENT_ENS`, which only matters if `ENS_PARENT` is ever overridden.
(`apps/web/src/world/**` and `pages/car.ts` had none.) `arena/` was not on my allowed list, so I left it.

## Internal `crumple` identifiers deliberately kept

- `@crumple/*` package scope, repo folder, root `package.json` name.
- `apps/web/src/pages/join.ts:220` sessionStorage key `crumple:session:<carId>` (a reader in another lane may depend on it).
- `apps/server/src/store.ts` default `data/crumple.sqlite`, `apps/server/src/wire.ts` dev signer seed, `apps/web/vite.config.ts` `CRUMPLE_API`.
- Key-derivation seeds (`crumple-agent`, `crumple:chain:*`, `crumple-weather-dev-seed`): renaming them would change derived addresses.
- `docs/lanes/world.md`: World client name "Crumple × Sekisho" and example host are the names registered in the World dev portal.
