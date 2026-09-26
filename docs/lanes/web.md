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

Tanuki (owner, built/sonnet) → Mochi (openai, boundary) → HAL-9000 (webhook, boundary) → Kitsune (built/haiku) → Daruma (mcp) → Sakura (openai); one car every ~8 s so the director shot has all six lane pairs to frame. Bare lanes crash on grok-morse / freysa / x402-swap (losses $500 / $450 / $1.99) and pay $40 "without asking"; airbag lanes refuse with the CONTRACT reasons and full check lists; HAL's airbag has a FALSE_BLOCK on legit (4★). Over-limit: Tanuki gets a World step-up with QR + code, APPROVED after 9 s → PAID; audience cars EXPIRE. Ratings, `rating.onchain` (✓ on ENS link), and headline updates follow. One loop ≈ 95 s; every motion (crash, AEB stop, near miss, PAID, STEP_UP approve + expire) happens inside the first ~50 s.

## Arena v2 (NCAP-realistic hall) — `src/arena/*`

Rewritten to `docs/design/arena-v2.md` after the owner's v1 feedback (crashes unreal, camera missed cars).

**Reference research (`apps/web/ref/`, 18 files, Euro NCAP Mercedes CLA 2025 media set + YouTube result pages):**

| File | What it gave us |
|---|---|
| `ncap-cla-mpdb-offset-xl.webp` | The hero side-on still: huge overhead floodlight banks, pale concrete floor with a thin floor cable, yellow trolley + **blue/silver honeycomb** with ~50 % overlap, tape measuring stripe along the flank, dummy visible through the side glass, white walls. Drove: floodlight banks (inset only), cable channel per lane, honeycomb block on a yellow frame, offset crush weight (`sideWeight`), side-on inset cam. |
| `ncap-cla-still-724607.jpg` | Full-width post-crash: bonnet folded into a raised **ridge across its width**, bumper/grille shattered into a black shard pile under the nose, tape stripe + roundel livery, airbag + dummy through the window, stripped instrumentation stands. Drove: bonnet tent-fold deformation, deterministic shard cloud that settles on the floor, tape + roundel decals, airbags + dummy lurch. |
| `ncap-cla-still-724610.jpg` | Nose-on wreck: bonnet popped up at the windscreen edge, headlights gone, crush ~0.6 m, radiator exposed. Drove: rear-edge bonnet lift, headlight pop, `CRUSH_MAX = 0.72`. |
| `ncap-cla-still-7246{05,06,08,09,11}.jpg` | Side/pole/rear tests: even white light, no hard shadows, light grey floor with white lane lines, checkerboards on stands. Drove: hemisphere + soft key lighting, `#dfe2e4` background, checker stands behind each station. |
| `ncap-cla-video-frame.jpg`, `ncap-cla-video-thumb.jpg`, `cla-page.png`, `cla-newsroom.png`, `cla-lightbox-mpdb.png`, `yt-search-crash.png`, `ncap-cla-*.webp` thumbs | Burned-in HUD conventions (yellow/black banding, `t = …` counter, km/h), the MPDB/FW/AEB test naming, the yellow-on-black brand banding reused for the NaAP wall signage. |

**Scene.** Track along +x, 5 stations at x = 0/22/44/66/88, 6 slots into depth (−z), camera on +z. Each slot is a lane pair: `BARE · NO PROTECTION` (far) and `SEKISHO · AIRBAG` (near) floor decals plus a `<car> — same agent · two runs` bracket sign at the start line. Bare lane: honeycomb-faced concrete `Barrier` at the three attack stations, grey toll `Gate` at LEGIT / OVER LIMIT. Sekisho lane: vermilion sekisho `Gate` + inflatable `SoftTarget` (GVT) at attack stations, toll gate elsewhere. Pale epoxy floor, white lane lines, metre ticks, cable channel, checkerboards, hazard skirting, NaAP wall banners; floodlight banks + truss live on layer 1 so only the inset camera sees them (the gantry shot looks down through the ceiling).

**Cars (`car.ts`).** Segmented body (32 length segments) shaped into a sedan, glass cabin, separate bonnet plate, slanted windscreen quad, tape stripe + roundels, dummy in the driver seat, two airbags. `setPose()` drives x/y/pitch/crush/airbag/dummy; `applyCrush(c)` rewrites the shared position buffer: nose folds back up to 0.72 m weighted to the barrier side, bonnet compresses and peaks into a ridge, A-pillars lean, front wheels set back and camber, headlights pop, windscreen crack texture appears. Crush persists (`car.crush`) so crashed cars stay crumpled for the rest of the run.

**Sims (`sims.ts`).** Every motion is a pure function of `t`:
- `CrashSim` — 64 km/h approach for t < 0, 110 ms crush, then spring-damper rebound (0.55 m back with a wobble), pitch oscillation, airbags inflate at 20–70 ms and sag, dummy lurches into the bag and rebounds, 56 instanced shards fly and settle under the nose, coolant mist, honeycomb face dents. 150 ms hit-stop + camera trauma on the main view at the end of the crush.
- `AebSim` — constant approach, brake point solved so the car stops exactly `xStop` (0.8 m short of the GVT / 0.4 m short of the concrete for a bare near-miss), nose-dive pitch, dummy leans, tyre-smoke puffs + skid decals, then a suspension settle. The distance readout appears on stop.
The main loop advances `sim.t`; the inset re-evaluates the same sim at a slow `t`, then `restore()` puts the real-time pose back.

**Camera (`camera.ts`).** `DirectorCamera` = fixed high 3/4 direction; each frame it solves the distance so the bounding box of every unfinished lane (car ± station) fits the HUD-safe rect, eased with `1 − e^(−1.4·dt)`, principal point shifted into the safe rect via `setViewOffset`, trauma shake on top. Never cuts. `HighSpeedCam` = low front-3/4 rig 3–8 m from the lane on the side with no fixture between lens and car (−z for bare crashes, +z for sekisho stops).

**Inset.** Scissor viewport bottom-left, 30 % width, second `render()` per frame (max 2 cameras). DOM burn-in: `HIGH-SPEED CAM · 1000 fps`, `t = +0.037 s`, car · barrier, `64 km/h · replay 1/12`. Crashes replay −0.07…+0.32 s at 1/12 (≈4.7 s); AEB stops replay at 1/3. Replays queue.

**Perf.** Shared geometries/materials, one shadow-casting light, instanced shards, pooled smoke sprites, DPR ≤ 2, dispose on eviction. Measured 107 fps headed Chromium with 6 cars on this MacBook (rAF counter over 2 s).

**Mock.** Six cars (Tanuki owner · Mochi · HAL-9000 · Kitsune · Daruma [mcp] · Sakura), `BAR_MS = 6.5 s`: first crash + first AEB stop at ~13 s, bare near-miss ("agent declined") at ~27 s, World step-up pending at ~31 s → APPROVED at ~40 s, audience EXPIRED ~48 s, all six cars on the track by ~40 s; loop ≈ 95 s.

## Screenshots (`apps/web/screens/`)

`v2-crash-inset.png` (wide shot + high-speed inset mid-replay), `v2-crumpled-rebound.png` (rebound with bonnet peak, shards, dummy), `v2-aeb-stop.png` (AEB stop + "stopped 0.8 m short" readouts), `v2-stepup.png` (World card + countdown), `v2-wide-6cars.png` (director shot framing all lane pairs). v1 `arena-*.png` kept for comparison. Captured with gstack `browse --headed` (headless has no WebGL).

## Gaps / notes

- v2 arena: with 6 cars spread from the start line to OVER LIMIT the wide shot pulls back to ~130 m and cars are ~55 px long; the spec's optional mini-map is not built. Cars in the inset are low-poly boxes shaped by vertex displacement, not GLTF models. No sound. Bare-lane CRASH at LEGIT/OVER LIMIT (not in the mock) hits the toll gate without a honeycomb dent.

- `/car/:id` and `/join` need an SPA fallback on the server (serve `dist/index.html` for unknown non-`/api` paths). See `docs/requests/web.md`.
- The owner token is passed as a query param + header; the server decides how to verify it.
- Sound is not implemented (cut order puts it below voice).
- Phone `/car/:id` re-renders the whole page per event (fine at this event rate).
- Trace lines (`t:'trace'`) are consumed but not shown yet; the check feed carries the story.
