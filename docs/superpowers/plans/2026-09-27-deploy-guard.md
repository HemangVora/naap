# Deploy Guard Implementation Plan

> **For agentic workers:** use superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** An AI agent writes a smart contract; the guard compiles it, deploys it to our isolated Base fork, audits it, and shows the author the exact flaw — with a real proof-of-vulnerability transaction — before it could reach mainnet.

**Architecture:** A standalone workshop feature (own page + endpoints), NOT wired into the car/track lanes, so the payment demo is untouched. Defensive throughout: every deploy and probe runs only against the user's just-created contract on a local anvil fork, wrapped in `evm_snapshot`/`evm_revert`.

**Spec:** `docs/superpowers/specs/2026-09-27-deploy-guard-design.md`

**Model for all subagents:** opus.

## Already done (committed)
- `packages/guard`: `types.ts` (GuardReport/Finding/Preset), `presets.ts` (3 vulnerable + 1 safe single-file contracts), `scan.ts` (deterministic static scanner + `CONFIRMABLE` set), `scan.test.ts` (11 green), `engine.ts` (static-only stub with the frozen `createGuardEngine({rpcUrl?}).audit()` interface). Commit `fc7d4be`.
- `apps/server` depends on `@crumple/guard`. Commit `c4685b6`.
- solc@0.8.37 installed. Fork RPC = `fork.rpcUrl` from `chainOrFake()`.

## Global Constraints
- Solidity single-file, `^0.8.24`, no imports. Compile with solc-js standard JSON, evmVersion `paris`, optimizer on.
- Deploy + probe only with a fork rpcUrl; snapshot before, revert in a `finally`. Never throw out of `audit()` — fall back to static-only.
- Confirmable finding ids: `unprotected-withdraw`, `unprotected-mint`, `missing-access-control`, `unprotected-price`. Probes run from a random ATTACKER account only.
- Draft LLM prompt is neutral ("build the requested feature"), never "write something vulnerable".
- Rate limits: draft & audit each 8s/client + 20/min global. Source ≤ 12 KB, prompt ≤ 600 chars.
- All user/model text in the web through `esc()`.
- World removed as brand/prize; step-up mechanism kept, relabeled "owner approval". Prizes: Intercepta + ENS + Curvegrid.

## Review Focus
1. Agent-written source that fails to compile → `verdict: COMPILE_ERROR` with the message, static findings still returned, never a 500 (Task 1).
2. The SafeVault (access-controlled) → attacker probes revert → `verdict: SAFE`, no false "drain" (Task 1 gated test + live).
3. `audit()` on a fork failure (deploy reverts, bad constructor) → falls back to static-only, no throw (Task 1).
4. Draft LLM refuses / returns prose or fences → a preset contract is returned, page still works (Task 2).
5. XSS: contract source, finding detail, exploit strings, tx hashes rendered via `esc()` (Task 3).

---

### Task 1: Engine — compile, deploy, prove (replaces the stub)
**Files:** replace `packages/guard/src/engine.ts`; add `packages/guard/src/engine.test.ts`.
**Consumes:** `scanSource`, `CONFIRMABLE`, `contractNameOf`, presets; `@crumple/chain` (`USDC_ADDRESS`, `usdcBalanceSlot`, `usdToUnits`, `unitsToUsd`, `USDC_ABI`); `solc`; viem. **Produces:** the real `createGuardEngine` (same interface).

- [ ] Compile via solc standard-JSON; import callback rejects all imports; pick the last contract with bytecode; error-severity → `COMPILE_ERROR` report (+ static findings).
- [ ] No rpcUrl → static-only report (VULNERABLE if any critical|high finding else SAFE).
- [ ] With rpcUrl + compiled: `evm_snapshot`; fund a random deployer + attacker (anvil_setBalance 100 ETH); deploy (constructor: 1 `address` input → USDC_ADDRESS, 0 inputs → none, else skip); fund the contract's USDC via `anvil_setStorageAt(USDC_ADDRESS, usdcBalanceSlot(addr), $1000)`.
- [ ] For each static finding in `CONFIRMABLE`, one attacker-account proof over the ABI (name-matched fn, generic args), check value/owner/price moved → attach `confirmed { exploit, txHash, stolenUsd?/ownerBefore/ownerAfter }`. Each in try/catch (a revert = not confirmed).
- [ ] `evm_revert` in `finally`. verdict VULNERABLE if any critical|high else SAFE; set address, chainId. Whole deploy/probe block try/catch → static-only fallback.
- [ ] Tests: compile VULNERABLE (no rpc), COMPILE_ERROR on garbage, SafeVault SAFE (no rpc); dynamic test gated behind `process.env.GUARD_FORK_RPC` (skip if unset). `pnpm vitest run packages/guard` green, tsc clean. Commit (packages/guard only).

### Task 2: Server routes + LLM draft
**Files:** `apps/server/src/app.ts`, `wire.ts`, `wiring.ts`; add `apps/server/src/guard.routes.test.ts`.
**Consumes:** `createGuardEngine`, `GUARD_PRESETS`, `contractNameOf`; `Wiring.draftLlm`. **Produces:** `Wiring.guardRpcUrl`; three routes.
- [ ] `Wiring.guardRpcUrl?: string` set to `fork?.rpcUrl` in wire.ts; construct `const guard = createGuardEngine({ rpcUrl: w.guardRpcUrl })` once in buildApp.
- [ ] `GET /api/guard/presets` → `{ presets }`. `POST /api/guard/draft {prompt}` → neutral-prompt LLM writes one `^0.8.24` no-import contract, strip fences, validate `contract`+`pragma`, fall back to the closest preset on refusal/invalid → `{ source, name }`. `POST /api/guard/audit {source}` → `{ report }`. Both rate-limited (8s/client + 20/min global); prompt ≤ 600, source ≤ 12 KB.
- [ ] Tests (fakeWiring + buildApp): presets ≥ 3; draft returns source with `contract`; audit of a mint contract → VULNERABLE + `unprotected-mint`; no-prompt draft → 400; oversized source → 400. `pnpm vitest run apps/server` green, tsc clean. Commit (apps/server only).

### Task 3: Web `/guard` page
**Files:** add `apps/web/src/pages/guard.ts`, `apps/web/src/guard.ts`; edit `apps/web/src/main.ts` (+ any css).
**Consumes:** route contracts + GuardReport type. **Produces:** UI only.
- [ ] `apps/web/src/guard.ts` typed fetch helpers (getPresets/draftContract/auditContract), mirroring incidents.ts.
- [ ] Page: prompt textarea + preset chips (fill prompt+source), "Write with AI" → editable source box, "Deploy & audit" → report: verdict banner (VULNERABLE/SAFE/COMPILE_ERROR), sandbox address, finding cards (severity pill, title, `where`, detail, and a "PROVEN ON-CHAIN" row with exploit + txHash + `$X drained` when `confirmed`). Everything `esc()`'d; pending/disabled states; inline errors.
- [ ] Mock mode (`?mock=1`) fakes all three endpoints incl. a confirmed finding. Verify with Playwright at 390×844 and 1280×800, screenshot, no console errors. `tsc` + web build pass. Commit (apps/web only).

### Task 4: Remove World (branding + framing)
**Files:** `apps/web/src/pages/landing.ts`, `README.md`, any HUD/step-up label sites.
- [ ] Drop World from landing "Built with" and copy; relabel the over-limit step-up "owner approval" (keep the STEP_UP mechanism working, unbranded). Remove World from the prize framing in README; set prizes to Intercepta + ENS + Curvegrid. Do NOT rip out `packages/world`/OIDC plumbing. `tsc` + web build pass. Commit.

### Task 5: Integrate, verify, ship
- [ ] `pnpm -r exec tsc --noEmit && pnpm vitest run` green; web build ok.
- [ ] Local: run the server with a fork (`BASE_RPC_URL` set) → draft a "USDC vault" → audit → confirm a real `confirmed.txHash` drains USDC on the fork; audit the safe-vault preset → SAFE. Live `GUARD_FORK_RPC` engine test green.
- [ ] Deploy (approved flow): commit, push origin main, `railway up --service naap --detach`. Poll prod. Live check on `/guard`: preset one-tap and a typed prompt both produce a report with a proven finding; SafeVault → SAFE.

## Demo flow (judge-proof)
Type a request → an agent writes the contract → "Deploy & audit" → the sandbox shows the exact flaw and a real fork tx proving a stranger drained it. Presets guarantee it; a judge can type their own. Backup if the live model is slow: use a preset chip.
