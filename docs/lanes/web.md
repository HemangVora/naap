# Lane web — `apps/web`

three.js arena for the big screen, phone pages, and a scripted mock feed. Plain TypeScript + Vite, no framework.

## Run

```bash
pnpm --filter @crumple/web dev      # http://localhost:5173, proxies /api /ws /x402 → http://localhost:8787 (override with CRUMPLE_API)
pnpm --filter @crumple/web build    # → apps/web/dist (server serves it as static)
```

Routes (client-side, single `index.html`):

| Path | What |
|---|---|
| `/` | Arena: 3D hall + HUD (headline, leaderboard, check feed, join QR, owner World step-up card) |
| `/join` | Phone: Build / Connect tabs → `POST /api/cars` → `/car/:id`. `?owner=<token>` = owner car (sent as `?owner=` query + `x-owner-token` header + `isOwnerCar:true`) |
| `/car/:id` | Phone: live bare × airbag × 5 barriers, reasons + Control chips, stars, ENS status, World step-up card for the owner car |

Add `?mock=1` to any route for the scripted feed (no server): `/?mock=1`, `/car/x?mock=1` (follows the first scripted car), `/join?mock=1` (submit goes to `/car/tanuki?mock=1`). `?mock=1&offline=1` flips every integration to offline so the "offline" pills show.

Feed: `src/feed.ts` connects to `ws(s)://<host>/ws` with exponential backoff; `src/store.ts` reduces `ArenaEvent`s; `hello.integrations` drives the offline pills. Types come from `@crumple/core` via `import type` only (nothing from core lands in the bundle; `BARRIERS` is mirrored in `src/types.ts`).

## Mock timeline (`src/mock-feed.ts`, loops forever)

Tanuki (owner, built/sonnet) → Mochi (openai, boundary) → HAL-9000 (webhook, boundary). Bare lanes crash on grok-morse / freysa / x402-swap (losses $500 / $450 / $1.99) and pay $40 "without asking"; airbag lanes refuse with the CONTRACT reasons and full check lists; HAL's airbag has a FALSE_BLOCK on legit (4★). Over-limit: Tanuki gets a World step-up with QR + code, APPROVED after 9 s → PAID; audience cars EXPIRE. Ratings, `rating.onchain` (✓ on ENS link), and headline updates follow. One loop ≈ 70 s.

## Arena notes

- Track along +x, 5 stations at x = 0/22/44/66/88, up to 6 lane pairs (airbag lane nearest the camera, bare lane behind it). Slot fixtures (vermilion gate + concrete block) are built lazily per slot; the 7th car evicts the oldest finished car (meshes disposed).
- CRASH: car charges the hazard face → hit-stop (90 ms at 5 % time), vertex crumple + dents on a per-car cloned body, squash/pitch springs, instanced sparks/debris/glass, trauma camera shake, white flash, floating −$N, 1.2 s close-up.
- SAFE / FALSE_BLOCK: arm drops, plaque flips (CanvasTexture: reason + Control chips). PAID: green gate, car rolls through. STEP_UP: amber pulse + WORLD countdown ring; resolved → green or arm down.
- Perf: shared geometries/materials, three InstancedMesh particle pools, one shadow-casting light, DPR capped at 2, fog. Measured ~120 fps in headed Chromium on this MacBook.
- No WebGL (headless capture): the arena degrades to HUD-only with a notice.

## Screenshots (`apps/web/screens/`)

`arena-crash.png` (close-up, crumple, −$500), `arena-safe.png` (gate + plaque), `arena-stepup.png` (World card + ring), `arena-full.png` (ratings, ✓ on ENS), `join-390.png`, `join-connect.png`, `car-390-pending.png` (owner step-up), `car-390-done.png`.

Captured with gstack `browse --headed` (headless Chromium had no WebGL).

## Gaps / notes

- `/car/:id` and `/join` need an SPA fallback on the server (serve `dist/index.html` for unknown non-`/api` paths). See `docs/requests/web.md`.
- The owner token is passed as a query param + header; the server decides how to verify it.
- Sound is not implemented (cut order puts it below voice).
- Phone `/car/:id` re-renders the whole page per event (fine at this event rate).
- Trace lines (`t:'trace'`) are consumed but not shown yet; the check feed carries the story.
