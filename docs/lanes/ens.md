# Lane ens — ENSv2 Sepolia mandates + ratings

## Done

`packages/ens` (`@crumple/ens`), tests green: `pnpm vitest run packages/ens` → 29/29, `pnpm -s typecheck` clean for this lane.

- `createEnsMandateSource(cfg)` — `MandateSource` on ENSv2 Sepolia (viem). `createForCar` returns the mandate immediately
  (`source:'local'` while pending) and, through the relayer queue, registers `<carId>.<parent>` (`PARENT_ENS`, default `naap.eth`) in our **UserRegistry**
  (owner = the car owner, **roleBitmap 0**) and writes the 4 `MANDATE_KEYS` text records on our **PermissionedResolver**
  in one `multicall`. Once mined the cached copy flips to `source:'ens'`. `get()` reads the records through the ENSv2
  **UniversalResolverV2** (`0x5d25c1d6…`) and resolves payees with `getEnsAddress`; `resolve()` = UR `addr` (60 s cache).
  Extras: `whenConfirmed(name)`, `status(name)`, `onConfirmed(cb)`, `layout()`, `probe()`, `readRecords`, `writeText`, `registerSubname`.
- `proveAgentCannotEdit(name, {send, fund})` — the agent key (derived `keccak(AGENT_SEED:carId)`, holds no roles) simulates
  `setText` → decoded `EACUnauthorizedAccountRoles(resource=keccak(key), ROLE_SET_TEXT, agent)`; with `send` it also broadcasts the
  reverting tx (relayer tops the agent up with 0.002 ETH when `fund`). Detail line is projector-ready.
- `createLocalMandateSource(cfg)` — EIP-191-signed JSON by the relayer key (or a throwaway), in memory; `get()` verifies the
  signature; `proveAgentCannotEdit` shows the forged-signature rejection. `createMandateSource()` (async) picks by `ENS_MODE`
  and **falls back to local** if Sepolia is unreachable or the parent isn't set up (logs why).
- `createRatingWriter(source)` — ENS: one `multicall` of 5 `RATING_KEYS` `setText`s, waits for the car's pending mandate write
  first, fires `onConfirmed(carId, txHash)`, never throws (errors in `.errors`). Local: records in memory, never confirms.
- **One nonce queue** (`nonceQueue.ts`): serial sends, local nonce, refetch + retry on `nonce too low/high`, `replacement
  underpriced`, `already known` (hash computed client-side so a re-broadcast is idempotent). Mandate source and rating writer
  share the same `Relayer` (cached per rpc+key), so there is exactly one queue per process. Fee: ≥1.5 gwei tip, maxFee ≥ 2×base.
- Per-key permissions: relayer holds root `ROLE_SET_TEXT_ADMIN` and `ROLE_SET_TEXT` **only on the 9 sekisho.*/naap.* keys**
  (via `grantSetterRoles` multicall), plus `ROLE_SET_ADDRESS` for `weather.<parent>`. Car token owners get no roles.

## Live on real Sepolia: `naap.eth` (2026-09-27 ~01:25 JST)

The product was renamed Crumple → NaAP, so the parent moved to `naap.eth`. `PARENT_ENS` (core) defaults to `naap.eth`;
`ENS_PARENT=<label>.eth` switches server + scripts to another parent (e.g. `crumple.eth`). Script state is per parent:
`packages/ens/deployment.<label>.sepolia.json`. The earlier `crumple.eth` deployment is kept in `deployment.crumple.sepolia.json`
and still resolves (its rating grants are for the old `crumple.*` keys; rerun `ENS_PARENT=crumple.eth … register` to add `naap.*`).

- `register naap.eth`: https://sepolia.etherscan.io/tx/0x6bc8fa48135d0e99f6ed5153d16cd74b718db97317cd2141430e3272fa803e94
  (UserRegistry `0xCD5B61Cb0b9eC5cA4e6674FE17169311D68Ab665`, PermissionedResolver `0xA93A04D15A58e2AeB629018ADA64e4015CCC85Db`)
- 9 `ROLE_SET_TEXT` grants: https://sepolia.etherscan.io/tx/0x8f5512fcfe1295b6a1a8f7b6ec474b49bc61ffcc567cbca17add3e418678d8e8
- `weather.naap.eth` → `0x16fB4859e0AC2b9e5E36DC5bB4EE654615a03D9C`: https://sepolia.etherscan.io/tx/0x32ac3d0d94b0b5d34fb0a1fd49ed29fee31f4161120d42f9adbd956a086692a4
- `naap-demo.naap.eth` mandate: https://sepolia.etherscan.io/tx/0x47be9887b5a462da8742db44a4b4f7a504c8ca881ca64c36dc596e7e174ed208 ·
  rating: https://sepolia.etherscan.io/tx/0xe26e0eff319837aad5772a6bfb7452854ca521f1462743ff112e5b97b148bd6e
- Agent edit **reverted on-chain**: https://sepolia.etherscan.io/tx/0x9951d8731dacf9bb8635515a5e77ea76794d69a64115d2976710fc4b3a3c38fb —
  `agent 0xe838…5161 called setText(naap-demo.naap.eth, "sekisho.perTxCapUsd", …) → EACUnauthorizedAccountRoles: the agent key holds no ROLE_SET_TEXT on resource keccak("sekisho.perTxCapUsd"); only the relayer 0xf784…00f7 holds it`

## Proven on an anvil fork of Sepolia (2026-09-26 19:10 JST, historical: parent was crumple.eth)

Full `register` → `smoke --send` ran green against `anvil --fork-url $SEPOLIA_RPC_URL` with the relayer funded via
`anvil_setBalance`: proxies deployed through the VerifiableFactory, MockUSDC minted/approved (8.000021 USDC/yr), commit →
60 s → `register`, `setParent`, 9 grants in one tx, `weather.crumple.eth` addr set; then `forkcar.crumple.eth` registered,
mandate read back through the UniversalResolver with `source=ens`, rating written, and the agent's `setText` **reverted
on-chain** with `EACUnauthorizedAccountRoles`. ~14 txs, ≈3.2 M gas total (register ~1.3 M, per car ~0.35 M, per rating ~0.15 M).

## Live steps (real Sepolia) — done for naap.eth (above); repeat with `ENS_PARENT=<label>.eth` for another parent

1. **Human:** send ≥ 0.1 Sepolia ETH to the relayer **`0xf78456BcfA81189fd7558DdeaA6c8C68075700f7`** (key already in `.env`).
2. `pnpm --filter @crumple/ens register` — idempotent/resumable (`packages/ens/deployment.<label>.sepolia.json`). ~3 min incl. the 60 s wait.
3. `pnpm --filter @crumple/ens seed-weather 0x<addr>` once lane intercepta picks the weather address (or set `WEATHER_ADDRESS` before step 2).
4. `pnpm --filter @crumple/ens smoke --send` → prints Etherscan + `sepolia.app.ens.domains` links (the 02:00 gate evidence).
5. `pnpm --filter @crumple/ens prove-eac <carId> --send --fund` for the projector.
6. Set `ENS_MODE=ens` in `.env`.

## Env

`SEPOLIA_RPC_URL` (publicnode works), `RELAYER_PK` (generated by `register`, never printed), `ENS_MODE=ens|local`,
optional `WEATHER_ADDRESS`, `AGENT_SEED`, `ENS_USER_REGISTRY`/`ENS_RESOLVER` (override on-chain discovery via
`ETHRegistry.getSubregistry/getResolver(<parent label>)`), `ENS_PARENT` (default `naap.eth`), `ENS_STATE_PATH` (fork dry-runs).

## Gaps / notes

- (19:15 JST, historical) not yet executed on real Sepolia then; since done — see above. Everything else is verified on the fork; addresses in
  `addresses.ts` were verified live with read-only calls (`isAvailable("crumple")=true`, price, UR `isENSv2()=true`).
- `register` waits on **block** timestamps; on a fork you must `evm_increaseTime 70` + `anvil_mine`.
- Each car costs 2 txs (~30–40 s on Sepolia) + 1 for the rating; the queue is serial, so ~10 cars/10 min. Fine for the demo.
- Subname expiry = 365 d; `naap.eth` (and the earlier `crumple.eth`) registered for 365 d.
- The subname token owner is the address passed to `createForCar` (falls back to the relayer if it is a contract without an
  ERC-1155 receiver). Server should pass the car's wallet or the presenter's address.
