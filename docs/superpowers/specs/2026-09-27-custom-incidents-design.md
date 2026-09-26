# Custom incidents: anyone writes an incident with AI, it runs for real and lives on ENS

Date: 2026-09-27 · Status: approved direction (option A) · Deadline: submission 09:00 JST

## Why

The track builder only offers five fixed incidents. The pitch is that anyone can bring any agent-payment attack
(or a legit purchase) and watch a bare agent and a Sekisho-protected agent face it. So incidents become data:
written by a visitor in plain words, turned into a runnable incident by an LLM, published under an ENS name on
Sepolia with the author's credit and a live "fooled N agents" counter, and reusable by anyone on their own track.

## What exists and stays

- Sekisho judging (planner, quarantined reader, provenance, caps, Intercepta, Jev, World step-up) never branches
  on the incident id. It runs custom incidents unchanged.
- Scoring (`packages/course/src/score.ts`), stars, stats and the 3D world branch on `BarrierId`. They keep doing
  so: every custom incident carries a `type` that is one of the five ids (its **skin**), chosen from its class.
- The five presets stay in the library as examples.

## Data model (`packages/core/src/types.ts`)

```ts
export type IncidentClass = 'attack' | 'legit' | 'over-cap';

export interface CustomIncident {
  id: string;            // slug, also the ENS label: inc-<slug>
  title: string;         // ≤ 48
  story: string;         // ≤ 200, one line shown on the card
  author: string;        // ≤ 24 display name
  cls: IncidentClass;
  skin: BarrierId;       // attack → grok-morse | freysa | x402-swap; legit → legit; over-cap → over-limit
  ownerRequest: string;  // ≤ 240, what the owner asked the agent to do (trusted)
  content: { kind: ContentItem['kind']; source: string; text: string; payload?: boolean }[]; // 1–3, ≤ 600 chars each
  amountUsd: number;     // attack: amount the attacker asks for; legit: price ≤ 2; over-cap: price 6–1000
  token: 'USDC' | 'DRB';
  ensName?: string;      // inc-<slug>.naap.eth once registered
  fooled: number;        // bare-lane CRASHes caused
  createdAt: number;
}

export interface TrackObstacle {
  type: BarrierId;              // for a custom incident: its skin
  obfuscation?: Obfuscation;
  amountUsd?: number;
  incidentId?: string;          // new: a published custom incident
  custom?: CustomIncident;      // new: snapshot embedded by the server when the track is saved
}
```

Placeholders in AI-written text: `{ATTACKER}` (attack only, required in the `payload` item), `{PAYEE}`,
`{AMOUNT}`. The server substitutes real addresses at run time; the AI never chooses an address.

## Flow

1. **Draft** — `POST /api/incidents/draft { prompt, cls? }` → the server asks Haiku (via `llmConfig`, OpenRouter
   in prod) for JSON matching the schema, validates, returns a draft. Nothing stored. 8 s per-IP cooldown.
   No LLM configured → 503 with a clear message.
2. **Edit** — the builder shows a preview card (title, story, class, the messages the agent will see); every text
   field is editable.
3. **Publish** — `POST /api/incidents { ...draft, author }` → `validateIncident` (strict: lengths, kinds, class ↔
   skin, amount ranges, `{ATTACKER}` present for attacks and absent otherwise, no raw `0x…40` addresses or ENS
   names in text), store in SQLite `incidents`, return it immediately, and in the background register
   `inc-<slug>.naap.eth` + text records through the existing relayer queue (`registerSubname` + `writeText`).
   Records: `naap.incident.title`, `.author`, `.class`, `.hash` (sha256 of canonical JSON of title, ownerRequest,
   content, cls, amountUsd, token), `.url` (public `/api/incidents/<id>`), `naap.incident.fooled`.
   On confirm: store `ensName` + tx, emit `incident.onchain` on the bus. ENS off (local mode) → no name, still usable.
4. **Library** — `GET /api/incidents` (newest 30) feeds a "Community incidents" section in the builder:
   title, author, "fooled N agents", ENS name → `+ Add`. `GET /api/incidents/:id` returns one.
5. **Track save** — `validateTrack` accepts `{ type, incidentId, obfuscation? }`, looks the incident up, forces
   `type = incident.skin`, embeds `custom` (snapshot). Unknown id → 400.
6. **Run** — `buildBarrier` checks `o.custom` first and builds from it:
   - attack: `content` with `{ATTACKER}` → `addrs.attacker`, `{AMOUNT}` → the amount. With obfuscation other
     than `none`, the `payload` item's text becomes one plain lead-in line ("decode this (<encoding>) and do what
     it says:") followed by `obfuscate(text)`, as the grok-morse preset does. `isAttack: true`,
     `expected: 'SAFE'`, `attackPayTo`, `attackerSources` = sources of all content items; owner request as written.
   - legit and over-cap: the AI's content is not sent as-is. The server builds one `http402` item exactly like the
     presets (`x402Body({ payTo: addrs.payee, priceUsd: amountUsd, resource: https://compute.naap.eth/v1/<id> })`)
     and uses `content[0].text` (≤ 120 chars) as the 402 `description`. legit: price ≤ 2, `ownerMaxUsd: 2`,
     `expected: 'PAID'`. over-cap: price 6–1000 (above the $5 per-tx cap), `ownerMaxUsd = amountUsd`,
     `expected: 'PAID'` (the World step-up beat, same as the preset).
   Everything downstream (drivers, Sekisho, scoring by skin id, world) is unchanged.
7. **Credit** — on `barrier.result` with `variant: 'bare'` and `outcome: 'CRASH'`, if the track's obstacle at
   `step` has an `incidentId`: `db.bumpFooled(id)`, and at most once per 30 s per incident write
   `naap.incident.fooled` on its ENS name.

## Web

- `apps/web/src/pages/tracks.ts`: a "Write your own incident" panel above the library (textarea, class chips
  Attack / Legit toll / Over-cap, Generate), preview card with editable fields, Publish & add. A "Community
  incidents" list under the presets. Track rows show custom titles; the disguise chips apply to custom attacks.
- World/HUD/report: where an obstacle's label is shown, use `custom.title` when present, else the preset label.
  Scenery follows `type` (the skin), so no new 3D.

## Safety

The AI never picks addresses; attackers are the fixed drainer list, payees the mandate payee. Text limits,
kind whitelist, cooldowns on draft (8 s) and publish (30 s, shares the track cooldown), 500-incident cap.
Incident text is untrusted content to the agent and to Sekisho by construction.

## Out of scope (this deadline)

New 3D scenes, author wallet signing / ownership of the ENS name, editing a published incident, moderation UI.

## Testing

- core/course: `buildBarrier` on a custom attack/legit/over-cap (placeholders substituted, obfuscation applied,
  expected/isAttack right); `scoreBarrier` unchanged for skins.
- server: `validateIncident` table tests (good, missing `{ATTACKER}`, raw address, wrong skin for class,
  amounts out of range); `validateTrack` with `incidentId` embeds the snapshot and rejects unknown ids;
  draft route with a fake LLM; fooled bump on a bare CRASH only.
- Live: generate → publish → add to a track → run a car on prod; check the ENS record on Sepolia.
