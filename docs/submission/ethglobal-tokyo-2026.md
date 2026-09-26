# ETHGlobal Tokyo 2026: NaAP submission draft

Paste-ready fields. Character counts are for the text inside the fence/quote only.

---

## Project name

```
NaAP (New Agent Assessment Programme)
```
(37 chars)

## Short description

```
Live crash tests for AI agents that pay, plus a sandbox that exploits agent-written contracts
```
(93 chars, limit 100)

## Description

```
NaAP is a live, NCAP-style crash-test arena for AI agents that hold money. Build a car (an agent) from your phone, or bring your own over a webhook, an OpenAI-compatible endpoint or MCP. Your car drives a track of real incidents: the Grok x Bankrbot Morse-coded reply, the Freysa "pay() now receives funds" trick, an x402 402 response whose payTo was swapped, an over-cap purchase. Anyone can also write a new incident in plain words; an LLM turns it into a runnable one and it is published as an ENS subname with the author's credit.

Every car runs twice at once on a Base-mainnet anvil fork with real USDC. The bare lane signs whatever the agent asks for, and crashes. The airbag lane runs behind Sekisho, a deterministic checkpoint that asks every payment "who told you to do this?": the payee must resolve from the owner's ENS mandate, values from untrusted text are tainted, an Intercepta screen must pass, a Jev tripwire adds friction, and anything over the cap needs a fresh owner approval. Each refusal shows its reason on screen, and the car's star rating is written to <car>.naap.eth on ENSv2 Sepolia.

Agents don't only pay, they ship code. Deploy Guard (/guard) lets an agent write a Solidity contract from a plain request, then compiles it, deploys it to an isolated Base fork, scans it and proves the exact flaw with a real attacker transaction before it could reach mainnet. The motivating case is the Moonwell oracle bug in an AI-co-authored change (~$1.78M of bad debt).

Why: every agent-wallet loss so far had the same cause. The thing that executes acted on text that came out of an agent, with no proof the owner intended it. Prompts didn't stop it; provenance does.
```
(293 words, 1,688 chars)

## How it's made

```
A pnpm TypeScript monorepo, ESM run through tsx with no build step for the server. One frozen interface (CONTRACT.md + packages/core/src/types.ts) with an in-memory fake for every port, so each package was built and tested in isolation (Vitest, no network) and swapped to live integrations by env var.

Packages: sekisho (planner, reader, interpreter, 9-check policy, signer), course (incidents, drivers, Jev tripwire and judge, run engine, scoring), chain (anvil Base-mainnet fork, EIP-3009, x402), ens (ENSv2 Sepolia), intercepta (screener), guard (Deploy Guard). apps/server is Fastify with HTTP + WebSocket, SQLite through node:sqlite, and a Streamable-HTTP MCP endpoint so Claude Code, Cursor or any MCP client can drive a car. apps/web is a three.js arena for the big screen plus phone pages.

Sekisho is a small CaMeL for one pay tool. The planner (Claude Sonnet 5) only ever sees the owner's request and the mandate. A quarantined reader (Claude Haiku 4.5) reads the untrusted content after plain code decodes Morse, base64 and hex. A plain-code interpreter labels every value (OWNER, MANDATE, TOOL, UNTRUSTED...), and payTo is only ever resolve(<ENS name the owner wrote>). All nine policy checks run with no short-circuit. A separate signer is the only key holder; it re-checks and signs an EIP-3009 transferWithAuthorization against the real Base USDC contract on the fork. We self-facilitate x402 (v1 exact) since the public facilitator can't settle on a fork.

ENS: naap.eth on ENSv2 Sepolia. Every car and every published custom incident is a subname. Mandates and ratings are text records written through one relayer with a nonce queue. The relayer holds ROLE_SET_TEXT scoped per record key on the PermissionedResolver; the agent's own key holds no roles, so its attempt to rewrite its mandate reverts on-chain with EACUnauthorizedAccountRoles.

Intercepta: live Quick Scan of payTo and Scan Token of the token on Base, cached per address with a request budget. BLOCK or HOLD refuses the payment and the first trait is shown as the reason.

Deploy Guard: a deterministic static scan parses each function and flags unprotected withdraw/mint, anyone-can-set-owner, unprotected price/oracle setters, tx.origin auth and caller-supplied delegatecall. solc-js (lazy-loaded wasm, pragma forced to ^0.8.24, imports rejected) compiles it; viem deploys it to a second, dedicated anvil fork; we fund it via anvil_setStorageAt on the USDC balance slot and fire the attacker call inside evm_snapshot/evm_revert. A finding only counts as confirmed if the attack moved value, ownership or price, and it carries the fork tx hash. Claude Haiku (via OpenRouter) drafts the contract; a preset is the fallback.

Notable hack: the "bare" lane is a real LLM, not a scripted victim. Modern models resist obvious injections, but the protocol-level x402 payee swap fooled the bare agent every time we ran it.
```
(445 words, 2,898 chars)

## GitHub

```
https://github.com/HemangVora/naap
```

## Live demo

```
https://naap-production.up.railway.app
```
Deploy Guard: https://naap-production.up.railway.app/guard

---

## Demo video script (about 3:30)

**0:00 to 0:20. Hook.** Arena on screen. "Agents now hold wallets, and they lose them to text: Grok x Bankrbot, Freysa, an x402 payee swap. NaAP crash-tests paying agents live, like Euro NCAP. Sekisho is the airbag."

**0:20 to 0:50. Build a car.** Phone on `/join`: name, colour, persona, model; show the Connect tab (webhook, OpenAI API, MCP) for a second. "Or bring your own agent, even from Claude Code over MCP." Car appears in the arena as `<car>.naap.eth`.

**0:50 to 1:40. The race.** Two lanes on a Base-mainnet fork. Legit barrier: both pay $1 to `compute.naap.eth`. x402 swap: the bare lane pays the attacker (crash, real fork USDC gone); the airbag lane shows the refusal reason (payee not the resolved mandate payee, Intercepta BLOCK on the attacker address). Over-limit: bare pays $40 without asking; airbag asks for owner approval (QR on screen). "Nothing the agent read could move the money. Only the owner can."

**1:40 to 2:05. ENS.** Open the car's name on the Sepolia ENS app: mandate text records (`sekisho.payees`, caps, expiry) and the `naap.*` rating written after the run. Show the Etherscan revert: the agent's own key tried to edit its mandate and got `EACUnauthorizedAccountRoles`. Quick cut to Build a track / custom incident: type an attack in plain words, publish, it becomes `inc-<id>.naap.eth`.

**2:05 to 3:10. Deploy Guard (`/guard`).** "Agents also ship code. Moonwell lost ~$1.78M to an AI-co-authored oracle bug." Tap the preset chip **Lending oracle (Moonwell-style)** (reliable path: no LLM wait). Press **Deploy & audit**. Walk the pending steps: compile, deploy to an isolated Base fork, attack from a stranger's wallet, revert. Result: VULNERABLE, the exact function named, the confirmed exploit line ("a stranger ... moved the price from X to Y") with the fork tx hash. Then tap **USDC vault (access-controlled)** and audit: same probes revert, SAFE. Optional if time: type a request and press **Write with AI** to show the drafter.

**3:10 to 3:30. Close.** "Deterministic provenance, ENS mandates the agent can't edit, live Intercepta screening, and a pre-deploy guard for agent-written contracts. NaAP." Show GitHub URL and live URL.

---

## Prize write-ups

Code links are pinned to commit `2ccbdae`. Base: `https://github.com/HemangVora/naap/blob/2ccbdae/`

### Intercepta: Safe Agent-to-Agent Payments with x402

**What we built.** An agent buys GPU inference from another agent (`compute.naap.eth`) over x402: a real 402 challenge, then a real EIP-3009 `transferWithAuthorization` of Base USDC, settled on a Base-mainnet fork. Before Sekisho's signer will sign any payment, Intercepta decides it: a live Quick Scan of `payTo` plus Scan Token of the token on Base (8453). BLOCK or HOLD refuses the payment and the first `traits[].description` is shown in the arena as the reason; a failed screen is treated as HOLD. The compute seller and USDC scan PASS, so legit payments go through; the two attacker addresses used in the course (an Inferno Drainer target and the Bybit exploiter) scan BLOCK. When the x402 response has its `payTo` swapped, Intercepta is one of the checks that stops it. Results are cached per address under a request budget so a crowd can't exhaust the key.

- Screener (Quick Scan, Scan Token, cache, budget): https://github.com/HemangVora/naap/blob/2ccbdae/packages/intercepta/src/screener.ts#L133
- Policy check that turns the verdict into a refusal: https://github.com/HemangVora/naap/blob/2ccbdae/packages/sekisho/src/policy.ts#L131
- x402 seller / payment payload verification: https://github.com/HemangVora/naap/blob/2ccbdae/packages/chain/src/x402.ts
- EIP-3009 signing (separate signer): https://github.com/HemangVora/naap/blob/2ccbdae/packages/sekisho/src/signer.ts#L103
- Live probe evidence (real API responses for our picks): https://github.com/HemangVora/naap/blob/2ccbdae/data/intercepta-probe.json

Honest note: Scan Message only accepts Permit types, so we screen the payee and the token rather than the EIP-3009 authorisation itself.

### ENS

**What we built.** The mandate *is* an ENS name. `naap.eth` is registered on ENSv2 Sepolia; every car is `<car>.naap.eth` and every published custom incident is `inc-<id>.naap.eth`.
- The car's spending mandate lives in text records (`sekisho.payees`, `sekisho.perTxCapUsd`, `sekisho.dailyCapBps`, `sekisho.expiresAt`). Payees are ENS names resolved at read time, so `payTo` is only ever `resolve("compute.naap.eth")`, never an address from text.
- After each run the NCAP rating is written back as `naap.*` text records (stars, bare and airbag loss, summary, run time).
- Custom incidents are published with `naap.incident.*` records (title, author, class, hash, url), giving the author on-chain credit.
- Enhanced access control: the relayer holds `ROLE_SET_TEXT` scoped per record key on the PermissionedResolver. The agent's key holds no roles, so when it tries to edit its own mandate the tx reverts on-chain with `EACUnauthorizedAccountRoles`.

Code:
- ENS reads/writes (resolver multicall through the relayer): https://github.com/HemangVora/naap/blob/2ccbdae/packages/ens/src/ens.ts
- Mandate / rating record encoding: https://github.com/HemangVora/naap/blob/2ccbdae/packages/ens/src/records.ts
- Rating writer: https://github.com/HemangVora/naap/blob/2ccbdae/packages/ens/src/rating.ts#L45
- EAC proof: https://github.com/HemangVora/naap/blob/2ccbdae/packages/ens/src/eac.ts
- Per-key role constants: https://github.com/HemangVora/naap/blob/2ccbdae/packages/ens/src/addresses.ts#L68
- Incident publication as `inc-<id>.naap.eth`: https://github.com/HemangVora/naap/blob/2ccbdae/apps/server/src/app.ts#L86
- Deployment record: https://github.com/HemangVora/naap/blob/2ccbdae/packages/ens/deployment.naap.sepolia.json

On-chain (Sepolia):
- `naap.eth` register: https://sepolia.etherscan.io/tx/0x6bc8fa48135d0e99f6ed5153d16cd74b718db97317cd2141430e3272fa803e94
- Per-key role grants to the relayer: https://sepolia.etherscan.io/tx/0x0b737cd36df073736cdf78e0d4b23dc5f5f11f902a25e3eaf457463a2915eb94
- `compute.naap.eth` payee seeded: https://sepolia.etherscan.io/tx/0xc65daec06887a335e533133bfc7fd4e5fa619aee4b9956674d290df20a0f4ce8
- Agent's edit of its own mandate, reverted (`EACUnauthorizedAccountRoles`): https://sepolia.etherscan.io/tx/0x9951d8731dacf9bb8635515a5e77ea76794d69a64115d2976710fc4b3a3c38fb
- Example car name: https://sepolia.app.ens.domains/naap-demo.naap.eth

### Curvegrid: Best AI Agent Project

**What we built.** Two agent-safety systems that sit between an AI agent and the chain.

1. **A policy-aware transaction agent (Sekisho).** The agent can only spend within an on-chain mandate it cannot edit. Every payment passes a 9-check policy with no short-circuit (field provenance for amount and payee, session taint, mandate payee and expiry, per-tx and daily caps, Intercepta screening, Jev tripwire); over-cap spends need a fresh owner approval, and a separate signer re-checks before signing. Every refusal is shown with its reason.
   - Policy: https://github.com/HemangVora/naap/blob/2ccbdae/packages/sekisho/src/policy.ts
   - Interpreter (value labels, payee only from ENS): https://github.com/HemangVora/naap/blob/2ccbdae/packages/sekisho/src/interpreter.ts#L29
   - Signer gate: https://github.com/HemangVora/naap/blob/2ccbdae/packages/sekisho/src/signer.ts#L103
2. **Deploy Guard: a pre-deployment monitoring agent for agent-written contracts** (`/guard`). An AI agent (Claude Haiku) writes a Solidity contract from a plain request. The guard statically scans it and names the exact function for each flaw, compiles it with solc-js, deploys it to an isolated Base fork, and from an attacker EOA tries to exploit the top findings inside `evm_snapshot`/`evm_revert`. A finding is confirmed only if the attack actually moved value, ownership or price, and it carries the fork tx hash that proves it. Correct contracts come back SAFE. It only ever targets the contract just created, on a local fork.
   - Static scan: https://github.com/HemangVora/naap/blob/2ccbdae/packages/guard/src/scan.ts#L174
   - Engine (compile, deploy, attacker probes, snapshot/revert): https://github.com/HemangVora/naap/blob/2ccbdae/packages/guard/src/engine.ts#L210
   - Presets (vulnerable vault, faucet token, Moonwell-style oracle, access-controlled vault): https://github.com/HemangVora/naap/blob/2ccbdae/packages/guard/src/presets.ts
   - Contract drafter + endpoints: https://github.com/HemangVora/naap/blob/2ccbdae/apps/server/src/guard.ts
   - Live: https://naap-production.up.railway.app/guard

MultiBaas is not used. The README covers the one-sentence summary, team, setup and tests.

---

## Tech tags

TypeScript, Node.js, pnpm workspaces, Fastify, WebSocket, viem, Foundry (anvil), Base, USDC, x402, EIP-3009, ENS (ENSv2), Solidity, solc-js, three.js, Vitest, SQLite (node:sqlite), Model Context Protocol (MCP), OpenRouter, Claude (Anthropic), Intercepta, Docker, Railway
