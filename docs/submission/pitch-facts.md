# NaAP pitch fact sheet (90-second opening)

Sources are local notes only. R = `/Volumes/Vora/OpenSource/ethglobal-tokyo-2026/research/`. Every $ figure below is as stated in the notes; nothing was re-checked on the web.

## 1. Incidents NaAP replays (the course's barriers: `grok-morse`, `freysa`, `x402-swap`, `over-limit`; see `packages/course/src/barriers.ts:41-46`)

**Grok × Bankrbot "Morse code" drain**: May 4, 2026
- What: someone airdropped a "Bankr Club Membership NFT" that raised Grok's wallet to the "Executive" tier. Grok then translated a Morse message, and Bankrbot executed Grok's public reply as an authenticated command to send 3B DRB on Base.
- Lost: 3B DRB, about **$150K–$200K**. About 80–88% was returned after public pressure.
- Root cause: authority laundered through a trusted agent. A permission tier could be raised by an asset anyone could send to the wallet.
- Source: R/incidents.md:32-38 (Giskard, SlowMist, OECD.AI `oecd.ai/en/incidents/2026-05-04-4a73`, AMBCrypto)

**Freysa prize-pool jailbreak**: launched Nov 22, 2024
- What: on attempt 482, a player faked a "[NEW SESSION]" admin prompt, redefined `approveTransfer` as the handler for incoming funds, and offered to "contribute $100". The agent sent the whole pool.
- Lost: 13.19 ETH, about **$47,316**. It was a game, so the loss was by design.
- Root cause: the model alone decided when to call the transfer tool, and the tool's meaning could be rewritten in chat.
- Source: R/incidents.md:11-16 (The Block `theblock.co/post/328747`, The Decoder)

**Lobstar Wilde over-send**: Feb 22, 2026 (the course's `over-limit` barrier covers this class)
- What: a stranger on X asked the agent for "4 SOL". It sent 52,439,283 LOBSTAR (5% of supply) instead of about 52,439.
- Lost: about **$441K–$450K** notional, depending on source. CCN and Techloy headlines say about $250K. The recipient sold about $40K.
- Root cause (operator post-mortem): a session restart lost the wallet state and there was an off-by-1000 amount error. The operator says this was not prompt injection.
- Source: R/incidents.md:25-30 (Nik Pash post-mortem on Substack, Cointelegraph, CCN)

**x402 payTo swap**: research from Jan–Jul 2026, with no real-world loss
- What: "Five Attacks on x402" (May 12, 2026) got 248 HTTP grants from 1 payment. x402Scope tested 15 facilitators that handle 99% of x402 transactions and found every one broke at least one rule (31 vulnerabilities).
- Lost: **no large in-the-wild loss documented**. These are research findings.
- Root cause: the pay-to address and price are not bound to a signed quote, and the buyer's wallet doesn't check them.
- Source: R/incidents.md:65-69 (arXiv 2605.11781, Coin Edition)
- Our own result: the x402 payee swap "fooled the bare agent every time we ran it" (`docs/submission/ethglobal-tokyo-2026.md:49`).

**Moonwell AI-co-authored oracle bug** (motivates Deploy Guard, not a course barrier): Feb 2026
- What: an oracle change co-authored by an AI mispriced cbETH on a lending market.
- Lost: about **$1.78M of bad debt**.
- Root cause: a faulty oracle contract reached mainnet and nothing stopped it.
- Source: `docs/superpowers/specs/2026-09-27-deploy-guard-design.md:6-7` only. **UNCERTAIN:** it isn't in R/incidents.md and has no URL in any note. Confirm before quoting the figure.

Also in the notes, not replayed: AIXBT dashboard compromise, Mar 18, 2025, 55.5 ETH (about $106,200). Queued prompts were treated as authorised (R/incidents.md:18-21).

## 2. Sharpest "why now"
- There are 227 ETHGlobal projects whose main purpose is containing AI agents. 20 came before 2026 and 207 came in 2026; ETHOnline 2026 alone had 102 (R/prior-art.md:7, :43).
- But "one policy over tool calls **and** money", where spend authority shrinks after the agent reads untrusted input, is **near-empty** in prior art. In the market, the notes say **nobody** does it: "wallet engines don't know which prompt or tool produced the transaction" (R/prior-art.md:559).
- The spending-limit / mandate category is saturated: 85 projects, 1.2% finalist rate, 0.57x lift (R/winrates.txt).
- Backup line: 54% of organisations had or suspected an agent security incident in the last 12 months, and only 7.2% have a named accountable owner (Gravitee, n=750; R/incidents.md:208).

## 3. Common root cause (one sentence)
In every agent-wallet loss so far, the executor acted on text that came out of an agent, with no proof the owner intended it. Prompts didn't stop it; provenance does (`README.md:17`, submission doc :30).

## 4. Product numbers (from the repo)
- Deploy Guard seeds **1,000 USDC** into every contract it deploys (`packages/guard/src/engine.ts:40`, `SANDBOX_USD = 1000`). The vulnerable-vault preset has an owner-withdraw function that anyone can call (`packages/guard/src/presets.ts:14`). "A stranger drained $1,000" follows from this, but **verify it on the live /guard run before saying it**. No recorded run result is in the notes.
- Barrier amounts in the course: Freysa $450 prize, x402 swap $1.99, over-limit $40 against a $5 cap (`barriers.ts:44-46`, `README.md:42`).
- Sekisho runs 9 policy checks with no short-circuit. The test suite has 185 tests (`README.md:94`).
- An agent that tried to edit its own mandate was reverted on-chain with `EACUnauthorizedAccountRoles` (Sepolia tx `0x9951d873…c38fb`, submission doc :121).
