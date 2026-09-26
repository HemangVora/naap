# Lane chain — `@crumple/chain`

anvil Base fork · funding · EIP-3009 settle · x402 seller helpers · DRB · Dockerfile for Railway.

## Done

- `startFork(opts)` → spawns `anvil --fork-url $BASE_RPC_URL --fork-block-number <pinned> --chain-id 8453`, polls until `eth_chainId`/`eth_blockNumber` answer, returns `{ rpcUrl, port, forkBlock, stop }`. Pinned block: **51 813 000** (`DEFAULT_FORK_BLOCK`, 2026-09-26 ~19:00 JST) when `FORK_BLOCK` is empty; `FORK_BLOCK=latest` pins latest−16. Pinning lets anvil cache every fetched slot under `~/.foundry/cache/rpc/base/<block>`; warm start ≈ 0.8 s and near-zero upstream load. `BASE_RPC_URL` is redacted from anything anvil prints.
- `createChain({ rpcUrl, facilitatorPk })` implements core `Chain` (+ helpers, type `ChainWithHelpers`):
  - `fundCar(wallet, usd)` → `anvil_setStorageAt` on USDC slot 9 (`keccak256(abi.encode(wallet, 9))`), verified by `balanceOf` afterwards (throws on mismatch); `anvil_setBalance` 1 ETH gas; **DRB 1 000 per car** by impersonating the DRB/WETH pool. Also strips any code from the wallet (`anvil_setCode`) — see gotcha below.
  - `balanceUsd`, `balanceUnits`, `drbBalance`.
  - `settle(auth)` → simulates then sends `transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)` from the facilitator (`FACILITATOR_PK`, default anvil #0), waits for the receipt, returns `{ txHash }`. Concurrent settles are serialised (one facilitator nonce). Reverts surface as `settle: FiatTokenV2: authorization is used or canceled` etc.
  - `sendRaw(signedTx)` for DRB (plain ERC-20 `transfer` signed by the car key).
  - `lossFromReceipt(txHash, allowedPayees, wallet?)` / `lossFromReceipts` → reads Transfer logs: `{ lossUsd, paidUsd, transfers[] }`. USDC to non-allowed → `lossUsd`; DRB listed unpriced.
  - `snapshot()/revert()` via `evm_snapshot/evm_revert` — **tests only**; runs share one fork.
  - `verifyUsdcDomain()` reads `name()/version()/DOMAIN_SEPARATOR()` on the fork and checks them against `USDC_DOMAIN`.
- **`USDC_DOMAIN`** (verified live and on the fork; `DOMAIN_SEPARATOR = 0x02fa7265…834f`):
  `{ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 }`.
  Types: `EIP3009_TYPES.TransferWithAuthorization(from,to,value,validAfter,validBefore,nonce)`. Sekisho's signer: `signTypedData(authorizationTypedData(fields))` or just call `signAuthorization(account, { to, value, … })` → `Eip3009Auth`.
- x402 v1 `exact` scheme (shape = coinbase/x402 so real clients could pay us):
  - `paymentRequirements({ payTo, priceUsd, resource, description })` → `{ scheme:'exact', network:'base', maxAmountRequired, payTo, asset: USDC, maxTimeoutSeconds: 60, extra: { name:'USD Coin', version:'2' } }`; `paymentRequiredBody(...)` → the 402 JSON (`x402Version: 1, error, accepts: [...]`).
  - `decodeXPayment(header)` (base64 JSON → `PaymentPayload`, strict shape check) · `createXPayment(account, req)` (buyer side, tests/drivers).
  - `verifyPayment(xPayment, req)` → scheme/network, `to === payTo`, `value ≥ maxAmountRequired`, `validAfter ≤ now`, `validBefore ≥ now+6 s`, EIP-712 recovery equals `authorization.from`. Returns `{ valid, auth, payer, amountUsd }` or `{ valid:false, reason }`. On-chain state (balance, nonce reuse) is caught by `settle()`'s simulation.
- **DRB (stretch, done):** `DRB_ADDRESS = 0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2` (DebtReliefBot, Clanker, 18 dp, no EIP-3009). Faucet = Uniswap V3 DRB/WETH pool `0x5116…8923` impersonated (3.96e27 units at the pinned block). `DRB_DISABLED=1` turns it off → grok-morse uses USDC.
- Smoke: `pnpm --filter @crumple/chain smoke` → fork, fund $500, x402 402→sign→verify→settle $1 to the payee (paid 1 / loss 0), bare $450 to attacker (loss 450), replay refused, re-fund to exactly $500, DRB 250 via sendRaw. Runs in ~2–3 s warm.
- Root `Dockerfile`, `.dockerignore`, `railway.json` (Dockerfile builder, healthcheck `/healthz`).

## Run it

```sh
pnpm vitest run packages/chain                 # offline: 10 unit tests, fork tests skipped
pnpm --filter @crumple/chain test:fork         # loads ../../.env → 18 tests incl. fork
pnpm --filter @crumple/chain smoke             # end-to-end on a fresh fork
```

Server wiring (integrator):

```ts
import { startFork, createChain, paymentRequiredBody, paymentRequirements, verifyPayment, USDC_DOMAIN } from '@crumple/chain';
const fork = await startFork();                       // BASE_RPC_URL, FORK_BLOCK, ANVIL_PORT from env
const chain = createChain({ rpcUrl: fork.rpcUrl });    // FACILITATOR_PK from env
await chain.verifyUsdcDomain();                        // boot-time assertion
// /x402/compute/inference (alias /x402/weather/report): no X-PAYMENT → 402 paymentRequiredBody(req); with header → verifyPayment → chain.settle(v.auth)
```

Env: `BASE_RPC_URL` (required, never logged), `FORK_BLOCK` (empty = 51813000, or `latest`), `FACILITATOR_PK` (anvil #0 ok), `ANVIL_PORT` (8545), `ANVIL_PATH`, `DRB_DISABLED`.

## Railway (not run — integrator does this)

```sh
railway login
railway init            # new project, pick the repo root
railway variables --set BASE_RPC_URL=… --set FORK_BLOCK= --set FACILITATOR_PK=0xac09… --set SIGNER_SEED=… \
  --set ANTHROPIC_API_KEY=… --set INTERCEPTA_API_KEY=… --set WORLD_ISSUER=… --set WORLD_CLIENT_ID=… --set WORLD_CLIENT_SECRET=… \
  --set SEPOLIA_RPC_URL=… --set RELAYER_PK=… --set ENS_MODE=ens --set OWNER_TOKEN=… --set PUBLIC_URL=https://<app>.up.railway.app
railway up              # builds ./Dockerfile (node:22-slim + anvil 1.4.4 + pnpm 10.21), starts `pnpm --filter @crumple/server start`
railway domain          # public URL; PORT is injected by Railway and read by the server
```

Optional: a volume mounted at `/root/.foundry/cache` keeps anvil's fork cache across deploys (otherwise the first `startFork` after each deploy re-fetches USDC/DRB state once, a few hundred RPC calls). Healthcheck hits `/healthz` (300 s timeout so the fork can come up). Verified locally: `docker build .` succeeds (multi-stage, web bundle included) and `docker run --rm --env-file .env crumple:test pnpm --filter @crumple/chain smoke` passes inside the image (node 22.23, anvil 1.4.4, fork ready in ~1 s).

## Gotchas / known gaps

- **Do not use anvil's default accounts as car wallets.** Several of them (e.g. #9 `0x9965…`) carry EIP-7702 delegations on Base mainnet, so FiatToken verifies via ERC-1271 → `invalid signature`. `fundCar` now clears code on the wallet, and tests use fresh keys; the sekisho signer derives fresh keys from `SIGNER_SEED` so it is unaffected.
- `verifyPayment` follows x402 (`value ≥ maxAmountRequired`), so an overpaying car is accepted; the course caps amounts elsewhere.
- Loss is USDC-only in `lossUsd`; DRB shows up in `transfers[]` (see `docs/requests/chain.md`).
- The fork's clock is the pinned block's timestamp (~now at pin time); `validBefore = now + 300` from real wall-clock is fine for hours, but if the demo runs much later than the pin and anvil is not restarted, authorizations still validate (fork time only moves per mined block). Nothing to do unless we pin a very old block.
- The Dockerfile downloads the official `foundry_v1.4.4_linux_<arch>.tar.gz` (amd64 on Railway, arm64 locally via `TARGETARCH`) and runs `anvil --version` during the build, so a broken download fails the build, not the deploy.
- `apps/web` must keep a `build` script; the Dockerfile tolerates its absence (`|| echo skipped`) but then the server has no static bundle.
