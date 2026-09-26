# NaAP Deploy Guard: a pre-deployment security sandbox for agent-written contracts

Date: 2026-09-27 · Status: approved (build now) · Deadline: 09:00 JST

## Why
Agents don't just pay — they ship code. In Feb 2026 an AI-co-authored oracle change at Moonwell mispriced
cbETH and left ~$1.78M of bad debt: a faulty contract reached mainnet and nothing stopped it. NaAP already
crash-tests paying agents; Deploy Guard crash-tests *building* agents. An AI agent writes a contract, the guard
compiles and deploys it to our isolated Base fork, audits it, and shows the author the exact flaw **before it
could ever reach mainnet**. This is defensive vulnerability scanning (Slither/Foundry-shaped) inside the arena,
and it is exactly Curvegrid's "policy-aware / programmable asset controls" AI-agent brief, with real contracts.

## Scope (this deadline)
A standalone workshop feature (own page + endpoints). NOT wired into the car/track/lane run engine — that avoids
touching the payment demo. World is removed as a sponsor/brand; the human step-up stays as a generic owner
approval.

## Defensive boundary (hard)
Every deploy and every proof-of-vulnerability transaction runs ONLY against a contract the user just created, on
a local anvil Base fork, wrapped in `evm_snapshot`/`evm_revert` so it leaves no trace. No real network, no real
funds, no third-party contract is ever targeted. The probes exist to show a contract's own author its flaw.

## The audit (two layers)
1. **Static scan** (`scan.ts`, deterministic, no chain): parse the Solidity source + ABI and flag a curated set of
   high-value classes an agent commonly gets wrong. Each finding names the exact function and says what's wrong:
   - `unprotected-withdraw` — a value-moving external/public fn (token.transfer / .call{value} / selfdestruct) with
     no access control → anyone drains it. (critical)
   - `unprotected-mint` — public mint/issue with no guard → anyone mints. (critical)
   - `missing-access-control` — owner/admin setter (setOwner/transferOwnership) callable by anyone. (critical)
   - `unprotected-price` — price/oracle setter callable by anyone (the Moonwell class). (high)
   - `tx-origin-auth` — auth via `tx.origin`. (high)
   - `delegatecall-untrusted` — delegatecall to a caller-supplied address. (high)
   A non-view external/public fn is "guarded" iff its modifiers name access control (onlyOwner/onlyAdmin/onlyRole/…)
   or its body requires `msg.sender == owner`-style. view/pure fns are never flagged.
2. **Dynamic proof** (`engine.ts`, on the fork): compile (solc-js, forced pragma ^0.8.24, no imports), deploy,
   fund the sandbox contract's USDC via the existing storage-slot cheat, then from a funded **attacker EOA** attempt
   the top confirmable findings — call `withdraw`/`mint`/`setOwner`/`setPrice` and check the call succeeded and moved
   value/ownership. A success attaches `confirmed { exploit, txHash, stolenUsd?/ownerAfter? }` — a real tx hash on
   the fork proving it. On SafeVault the same calls revert → not confirmed → the guard reports SAFE.

## Data (`packages/guard/src/types.ts`)
`Severity = critical|high|medium|low`; `GuardVerdict = VULNERABLE|SAFE|COMPILE_ERROR`.
`GuardFinding { id, title, severity, detail, where?, line?, confirmed?: { exploit, txHash, stolenUsd?, ownerBefore?, ownerAfter? } }`.
`GuardReport { verdict, contractName, address?, chainId?, findings[], compileError?, source, auditedAt }`.

## Engine (`packages/guard/src/engine.ts`)
`createGuardEngine({ rpcUrl? }): { audit(source, {name?}): Promise<GuardReport> }`.
audit = static scan always; if rpcUrl + compile ok → deploy + dynamic-confirm (snapshot/revert around it); compile
error → COMPILE_ERROR with the message, source echoed. No rpcUrl → static-only (verdict from static findings).

## Server (`apps/server`)
- `POST /api/guard/draft { prompt }` → an LLM (Haiku via llmConfig) writes ONE self-contained Solidity ^0.8.24
  contract, no imports, for the requested feature (neutral prompt; accidental flaws are the point). → `{ source, name }`.
  Fallback to a preset on refusal/timeout/invalid. Cooldown 8s/client + 20/min global.
- `POST /api/guard/audit { source }` → `engine.audit` → `GuardReport`. Cooldown 8s/client + 20/min global; source ≤ 12 KB.
- `GET /api/guard/presets` → the preset scenarios `{ id, title, prompt, source }` (guaranteed demo path + judge one-tap).
- Wire the engine with the fork rpcUrl (same one chainOrFake uses); no rpcUrl → static-only, still returns a report.

## Web (`apps/web`, route `/guard`)
Prompt box + preset chips + editable Solidity source + "Deploy & audit". Report: verdict banner, deployed sandbox
address, each finding (severity, title, the exact function, plain detail), and for confirmed ones the exploit line +
tx hash + amount drained. A judge can type their own request and watch an agent build a contract and the sandbox
catch it, live. All rendered through esc().

## World removal
Drop World from landing "Built with" and copy; relabel the over-limit step-up as "owner approval" (keep the STEP_UP
mechanism working, unbranded); remove World from the prize framing in the README. Prizes: Intercepta + ENS + Curvegrid.

## Out of scope
Wiring deploy into the car lanes, a new 3D scene, import resolution / OpenZeppelin, a general analyzer, moderation.
