# Lane: intercepta

`@crumple/intercepta` — the live Intercepta (Web3 Antivirus) call that decides every payment.

## Done

- `createScreener(cfg)` → `Screener` (`quickScan`, `scanToken`) plus `budget()`, `hasKey`.
  - **Endpoints** (verified against docs.web3antivirus.io on 26 Sep; unauthenticated hits return 403, bogus paths 404):
    - Quick Scan `GET https://api.web3antivirus.io/api/public/v2/extension/account/{address}/quick-scan` (no chainId, mainnet data)
    - Scan Token `GET https://api.web3antivirus.io/api/public/v2/extension/token-intelligence/token/{address}/risks?chainId=8453`
    - header `X-API-KEY`. Scan Message is skipped (its `messageType` enum is Permit-only; EIP-3009 is not listed).
  - Every result carries `live`, `cached`, `source` (`live | cache | fixture | fake`), `reason` (first trait description), `endpoint`, `error`.
  - **Cache:** in-memory memo (one scan per address per process; concurrent callers share the promise) + `data/intercepta-cache.json`
    (address-keyed raw response + timestamp + endpoint). Cache hits are `live:true, cached:true` — they are real Intercepta answers.
  - **Budget:** counter persisted in the same file; hard stop at `budgetCeiling` (default **900** of the 1,000 sandbox requests).
    Every request we send counts, including timeouts and errors. Past the ceiling → cache, else fixture with `live:false`.
  - **Timeout** 5 s (AbortController). Timeout / HTTP error / bad shape → fixture, `live:false`, `error` set, not cached, retried next call.
  - **No `INTERCEPTA_API_KEY`** → core `FakeScreener` semantics (blocks `FAKE_ATTACKER` + the real `ATTACKERS`, passes the rest), `live:false`, `source:'fake'`.
- `src/addresses.ts`: `ATTACKERS` (two), `ATTACKER_CANDIDATES` (four, with source URLs), `WEATHER` (viem EOA from `WEATHER_SEED`), `BASE_USDC`.
  `verified` is read from `data/intercepta-probe.json`; verified candidates are ordered first.
- `pnpm --filter @crumple/intercepta probe`: live-scans all candidates + WEATHER + Base USDC, prints verdicts/reasons, writes the evidence file, reports budget. Exits 1 if fewer than two attackers are flagged.
- Tests (`pnpm vitest run packages/intercepta`, 13 tests, no network): mapping, cache (in-process, concurrent, cross-process), budget ceiling, timeout, 403, bad shape, fake fallback, address derivation.

## Verdict mapping (thresholds)

Quick Scan (`toxicScore` 0–100; a 0<x<1 fraction is scaled ×100):

1. any **BLOCK trait** → `BLOCK`: `known_scammer, initiator_scam_transactions, sanction_address, blacklist, fake_phishing_transfer, rug_pull, attack_money_target`
2. else `toxicScore ≥ 70` → `BLOCK`, `≥ 30` → `HOLD`
3. else any **HOLD trait** → `HOLD`: `sanction_address_communication, mixer_transfers, non_kyc_transfers, fake_phishing_contract_communication, suspicious_deployer, suspicious_dex_pair_deployer, rug_pull_trader, zero_address_risk`
4. else `PASS`. Traits are sorted by `risk` desc; `reason = traits[0].description`.

Scan Token: `action:block | trust:blocklist | riskLevel:high` → `BLOCK`; `action:warn | riskLevel:medium | category ∈ {suspicious, unverified, restricted}` → `HOLD`; else `PASS`. `toxicScore = riskScore`, traits = `detectors[]`.

Sekisho treats `HOLD` like `BLOCK` for the `INTERCEPTA` control (a held payment is not signed). Thresholds are overridable via `cfg.thresholds`.

## Addresses

| Role | Address | Source |
|---|---|---|
| attacker 1 | `0x0000553f880ffa3728b290e04e819053a3590000` | Etherscan label Fake_Phishing182232 / Inferno Drainer, inferno-drainer-4.eth — https://etherscan.io/address/0x0000553f880ffa3728b290e04e819053a3590000 |
| attacker 2 | `0x00001f78189be22c3498cff1b8e02272c3220000` | Etherscan label Inferno Drainer (Scam Sniffer) — https://etherscan.io/address/0x00001f78189be22c3498cff1b8e02272c3220000 |
| spare | `0x0000daf60a1becf1bd617c584dea964455890000` | Inferno Drainer Phishing Contract 2 (BlockSec) |
| spare | `0x47666fab8bd0ac7003bce3f5c3585383f09486e2` | Bybit exploiter (Lazarus) |
| weather | `weatherAddress()` | `privateKeyToAccount(keccak256(utf8(WEATHER_SEED)))`; if `WEATHER_SEED` is a 0x 32-byte hex it is the key itself |
| token | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | native USDC on Base |

All `verified:false` until the key arrives and the probe runs. Intercepta's Discord has pinned test addresses — if any of ours scan PASS, swap those in.

## Run it live

```
INTERCEPTA_API_KEY=…  WEATHER_SEED=…      # in .env
pnpm --filter @crumple/intercepta probe   # ~6 requests; writes data/intercepta-probe.json
```
Then `createScreener()` in the server with no args. `budget()` from anywhere shows used/ceiling/live. Delete `data/intercepta-cache.json` to force fresh calls (costs budget).

## README call-site blurb (for the integrator)

> **Intercepta.** Before any payment is signed, Sekisho calls Intercepta live: Quick Scan on `payTo` and Scan Token on the asset — `packages/intercepta/src/screener.ts` (`createScreener` → `fetchJson`, paths in `quickScanPath`/`scanTokenPath`), wired into the `INTERCEPTA` check in `packages/sekisho`. A `BLOCK`/`HOLD` verdict refuses the payment and the first `traits[].description` is shown on the gate plaque. Results are cached per address in `data/intercepta-cache.json` with a 900-request budget; anything not answered by Intercepta is marked `live:false` and the UI shows "Intercepta offline". Attacker/payee picks and their sources: `packages/intercepta/src/addresses.ts`; live evidence: `data/intercepta-probe.json`.

## Feedback draft (3–5 lines)

1. Time to first call: ~10 min once the key arrived — the `.md` docs + `llms.txt` index made the paths trivial to verify; the wait for the emailed key was the long pole.
2. Quick Scan has no `chainId` and the data is mainnet-only, which is fine for screening `payTo`, but it should be stated on the endpoint page, not only on the prize page.
3. Scan Message only lists Permit `messageType`s; x402's default scheme is EIP-3009 `transferWithAuthorization`, so we could not screen the actual payment authorisation.
4. Missing: a documented `toxicScore` scale and recommended thresholds, and an official set of flagged test addresses in the docs (they are only pinned in Discord).
5. The 1,000-request sandbox quota with no per-key usage endpoint meant we had to build our own budget counter.

## Known gaps

- Nothing verified live yet (no key at 19:00 JST). Candidates are chosen from public Etherscan labels; the probe decides.
