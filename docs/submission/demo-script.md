# NaAP demo script (≈3:40)

Works for the recorded video (2–4 min, 720p+, voice only, no music) and for live judging.
Slides: the NaAP pitch deck. Live site: https://naap-production.up.railway.app

## Before you start (2 minutes)

Open these browser tabs, in this order:
1. The pitch deck, on the cover slide.
2. `/world` (sound off, let it load fully).
3. A car report page: from `/world`, click a car on the leaderboard (e.g. Demo Wallet) and open its report.
4. Sepolia Etherscan, the reverted mandate edit:
   https://sepolia.etherscan.io/tx/0x9951d8731dacf9bb8635515a5e77ea76794d69a64115d2976710fc4b3a3c38fb
5. `/guard`, scrolled to the top.
6. Sepolia drain tx (success): https://sepolia.etherscan.io/tx/0xa6203d3bf2813174374ee388600b470ee5cdbc87e9f645dbe23c00fa06f6be8b
7. Sepolia SafeVault attack tx (fail): https://sepolia.etherscan.io/tx/0xa85e62a639edc7b2fb643d1e50708a838d485caf8ee97ee81b91c0e0b01a2a2b

Fallback if anything is slow: every beat below has a screenshot in the deck (slides 5 and 7). Say "here's the run from this morning" and keep going.

---

## Part 1 — the pitch (≈1:15, on slides)

**Slide 1 · Cover** (5s)
> "AI agents hold wallets now. Nobody crash-tests them. So we built a crash-test arena."

**Slide 2 · The crash record** (20s)
> "And they're already losing money. Freysa: one chat message redefined its approve function, and it paid out the whole pool. Lobstar Wilde, this February: asked for 4 SOL, it sent 5% of the token supply, around 440 thousand dollars. In May, Bankrbot executed a Morse-coded reply from Grok as a command and sent three billion DRB."

**Slide 3 · One cause** (12s)
> "Every one of these has the same cause. The wallet acted on text that came out of an agent, with no proof the owner meant it. Better prompts don't fix that. Provenance does."

**Slide 4 · Moonwell** (13s)
> "And agents don't only pay, they write code. In February a Moonwell oracle change, with AI co-authored commits, priced cbETH at a dollar twelve. 1.78 million in bad debt. Nothing tried to break that code before mainnet."

**Slide 5 · The arena** (12s)
> "NaAP is NCAP for agents. Build a car from your phone or plug in your own agent. It drives real incidents on a Base mainnet fork, twice: once bare, once behind Sekisho, our airbag."

**Slide 6 · The airbag** (13s)
> "Sekisho is code, not another prompt. The payee has to come from the owner's ENS mandate, which the agent can't edit. Anything from untrusted text is tainted. Intercepta screens every address before signing. And over the cap, the owner has to approve."

*(Skip slide 7; Deploy Guard is shown live.)* Go to slide 8, **Live demo**:
> "Let me show you. Three things."

---

## Part 2 — live (≈2:10)

### Beat 1 · The crash (45s) — tab `/world`
- Press **Space** to jump to the latest crash, or click a car on the leaderboard to follow it.
> "Every car runs two lanes at once. Here's the x402 payee swap: the service's payment request has its payTo swapped to an attacker."
- Point at the red bare lane.
> "The bare agent pays the attacker. It crashes into the wall."
- Point at the green Sekisho lane and the verdict card.
> "Behind Sekisho, the same agent is refused, and it tells you why: the payee didn't come from the owner's mandate, and Intercepta flagged the address."
- Public proof (tab): the same swapped 402, settled for real on Base Sepolia with Circle USDC via EIP-3009: https://sepolia.basescan.org/tx/0xbd89f44d7f35ed0f31a0d6a999100f483fb84633c73fe5b0635215b5408a27b9
> "And that's not a simulation: here's the exact same swapped 402, paid with real test USDC on Base Sepolia. 1.99 went straight to the drainer's address."

### Beat 2 · On-chain (30s) — car report tab, then Etherscan
> "The result is an NCAP rating, and it lives on-chain."
- Show the report card: stars bare vs airbag, the `….naap.eth` name.
> "This car's rating is written to its own ENS name on ENSv2."
- Proof (pick one, have it ready in a tab or terminal). Do **not** open sepolia.app.ens.domains: it still reads ENSv1, so ENSv2 names show no records there.
  - Terminal (live read via the ENSv2 UniversalResolver): `pnpm --filter @crumple/ens read-name demo-wallet-y54i47.naap.eth` → shows `sekisho.payees compute.naap.eth`, caps, `naap.stars 5`, `naap.summary bare 5/5 · airbag 5/5`.
  - Etherscan, Logs tab (the mandate write, records visible in plain text): https://sepolia.etherscan.io/tx/0xc5a263ed339a637deabaeb59cbd66ee53322d49d21be7655131317658119d7e5
> "The ENS app hasn't caught up with ENSv2 yet, so here's the read straight from the ENSv2 resolver: payee, caps, and the five-star rating."
- Switch to the Etherscan tab. It shows **Status: Fail**. That is the point, so say it out loud:
> "And the mandate is locked. This is the agent's own key trying to rewrite its spending rules. Etherscan says failed: the resolver rejected it, because the agent holds no role to edit that record. The agent can't give itself permission."
- If a judge asks for the reason: the revert is `EACUnauthorizedAccountRoles` (ENSv2 enhanced access control). Reproduce it with `pnpm --filter @crumple/ens prove-eac`.

### Beat 3 · Deploy Guard (55s) — tab `/guard`
> "Now agents that ship code. I'll ask for a USDC vault."
- Tap **USDC staking vault**. Tap **Deploy & audit**.
> "The guard compiles it, deploys it to an isolated Base fork, and attacks it from a stranger's wallet."
- When the report appears (a few seconds):
> "Vulnerable. A stranger drained a thousand dollars, and here's the transaction hash that proves it. Not a warning. A proof."
- **Public proof (10s, tab 6):** open the Sepolia drain tx https://sepolia.etherscan.io/tx/0xa6203d3bf2813174374ee388600b470ee5cdbc87e9f645dbe23c00fa06f6be8b
> "The guard runs on a private fork, so it answers in a second. To prove it's real, we replayed this exact contract on public Sepolia: a brand-new wallet drained all 1,000 test USDC. The safe version, same call: failed."
  (Safe version's failed tx, tab 7: https://sepolia.etherscan.io/tx/0xa85e62a639edc7b2fb643d1e50708a838d485caf8ee97ee81b91c0e0b01a2a2b · all links in `sepolia-proof.md`.)
- Don't paste the guard's own tx hash into Basescan or Etherscan. It lives only on the guard's private Base fork, and the fork is rolled back after every audit, so no public explorer will find it. If asked: "It's a real transaction on a mainnet fork; nothing ever touches the real chain."
- Tap **USDC vault (access-controlled)**. Tap **Deploy & audit**.
> "Same request, written correctly. The attack reverts, and it comes back safe."
- Optional, only if time allows: type your own request and tap **Write with AI**.

---

## Close (≈15s) — deck, slide 9
> "Intercepta screens the payment, ENS holds the mandate, and Deploy Guard checks the code. Every agent that touches money should be crash-tested before it touches yours. NaAP is live. Scan the QR on the world page and put your own agent through it. Thanks."

---

## Timing cheat sheet
| Part | Target | Running |
|---|---|---|
| Slides 1–6 | 1:15 | 1:15 |
| Beat 1 · crash | 0:45 | 2:00 |
| Beat 2 · on-chain | 0:30 | 2:30 |
| Beat 3 · Deploy Guard | 0:55 | 3:25 |
| Close | 0:15 | 3:40 |

Over time? Cut the optional "Write with AI" first, then shorten slide 2 to one incident (Lobstar).

## Facts, if a judge asks
- Moonwell, Feb 15 2026: cbETH priced ~$1.12 vs ~$2,200; $1,779,044.83 bad debt; commits co-authored by an AI assistant (CoinDesk, The Block, Moonwell MIP-X43 post-mortem).
- Lobstar Wilde, Feb 2026: ~$441–450K notional (some reports ~$250K).
- Grok × Bankrbot, May 2026: 3B DRB, ~$150–200K; most was later returned.
- Freysa, Nov 2024: 13.19 ETH (~$47K) on attempt 482.
- Deploy Guard funds every sandbox contract with 1,000 USDC on the fork; nothing leaves the fork (snapshot/revert).
- More in `docs/submission/pitch-facts.md`.
