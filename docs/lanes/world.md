# Lane: world — World ID for Agents step-up

`@crumple/world` · `createStepUp(cfg?)` implements the `StepUp` port. Owner car → real OIDC **device authorization grant** (RFC 8628) against `https://sandbox.auth.world.org`; audience cars → no network, `EXPIRED` after `ttlSec`.

## Done

- `packages/world/src/oidc.ts` — discovery (`/.well-known/openid-configuration`), `POST /api/v1/device_authorization` (scope exactly `openid`, `client_secret_post` or `client_secret_basic`), `POST /api/v1/token` poll classification (`authorization_pending` / `slow_down` +5 s / `access_denied` / `expired_token` / `invalid_grant` / 429 / 503), ID-token validation with `jose` (RS256 via remote JWKS, exact `iss`, `aud` = client id, `exp`, required `auth_time`).
- `packages/world/src/stepup.ts` — `createStepUp()`:
  - `allowApproval:true`: starts a device grant, returns `{ verificationUri: verification_uri_complete, userCode, expiresAt = min(device expiry, now + ttlSec) }`, polls; **APPROVED** only when the token validates and `auth_time ≥ request time − 60 s` (fresh proof, not `iat`); `access_denied` → **DENIED**; our ttl / `expired_token` → **EXPIRED**; a token that fails validation → **DENIED** with the reason (`audience mismatch`, `issuer mismatch`, `stale`, `token expired`, `bad signature`). Never throws — a grant that cannot start resolves `EXPIRED` with the reason so a run is refused, not crashed.
  - `allowApproval:false`: no network; `EXPIRED` after `ttlSec` with detail `No owner step-up within 60 s — payment refused`.
  - No `WORLD_CLIENT_ID`/`WORLD_CLIENT_SECRET` → wraps core `FakeStepUp`, `live:false`, `mode:'offline'`, logs `[world] OFFLINE …`. `isLive()` exported for the server's "World offline" pill.
- `pnpm --filter @crumple/world try` — one real step-up; prints the approval URL + user code, waits, prints the validated result. `try --deny` (tap Deny in World App), `try --ttl 30` (walk away → EXPIRED). Never prints secrets or tokens.
- Tests (`pnpm vitest run packages/world`, 16 tests, no network): approve incl. `interval`/`slow_down` timing, denied, ttl expiry, device-code expiry, bad aud / iss / stale `auth_time` / expired / unknown key all rejected, audience path makes zero calls, offline fallback, basic-auth wire shape.

Verified live on 2026-09-26 19:40 JST: discovery document, JWKS (one RS256 key, kid `SjxoYTY6…`), and the device endpoint (`invalid_client` without credentials). The guide text at `/mcp` (`get_idp_guide oidc`) matches the research notes.

## Env

| var | value |
|---|---|
| `WORLD_ISSUER` | `https://sandbox.auth.world.org` (default) |
| `WORLD_CLIENT_ID` | from the portal |
| `WORLD_CLIENT_SECRET` | from the portal, shown once |
| `WORLD_CLIENT_AUTH` | `client_secret_post` (default) or `client_secret_basic` — must equal the method chosen at registration (immutable) |

## Human steps: register the portal app (≈5 min)

1. Open <https://sandbox.auth.world.org/portal>, sign in with Google. If you see `account_not_eligible` / `client_registration_disabled`, that is an organizer allow-list issue, not a proof failure → World booth.
2. Create an OIDC client:
   - Name: **Crumple × Sekisho** (the approval page shows this to the owner — keep it recognisable on the projector).
   - Client authentication: **`client_secret_post`** (our default). If only Basic is offered, pick it and set `WORLD_CLIENT_AUTH=client_secret_basic`.
   - Redirect URI (required even though the device grant never uses it, exact match, HTTPS in sandbox): **`https://<railway-host>/auth/world/callback`**, e.g. `https://crumple.up.railway.app/auth/world/callback`. The redirect **hostname becomes the immutable pairwise sector** — use the real deploy host, not localhost.
   - Scope: `openid` is the only scope; nothing else to tick.
3. Copy the client ID and the secret (shown **once**) into `.env` as `WORLD_CLIENT_ID` / `WORLD_CLIENT_SECRET`. Do not paste the secret into chat.
4. On the presenter's phone: World App sandbox — iOS TestFlight <https://testflight.apple.com/join/Tub7zuyD> (Android: private Play track via developer.world.org → World ID Sandbox). See open question 1: the prize brief says proofs are mocked and the app may not be needed.
5. Smoke test: `pnpm --filter @crumple/world try` → open the printed URL (or scan it), approve → `status APPROVED`. Then `try --deny` → `DENIED`, and `try --ttl 30` (do nothing) → `EXPIRED`. Note the wall-clock time of the first `APPROVED` for the debrief.

## Runtime behaviour worth knowing

- The owner ttl is 300 s but World's device code lives 20 min. After our EXPIRED we stop polling; a late approval in World App is ignored by us (payment stays refused). Nothing on World's side can be cancelled from the backend.
- One device start per over-limit barrier of the owner car; starts are rate-limited per client (429 + `Retry-After: 60`). Do not spam `try`.
- The ID token carries only `iss, sub, aud, exp, iat, jti, auth_time, acr, amr` — no name/email. `subject` in `StepUpResult` is the pairwise `sub`; the UI truncates it.
- JWKS is cached 10 min with a 30 s cooldown on unknown `kid` (key rotation safe).

## Integration debrief (draft for the prize submission — fill in the two blanks after the live run)

**What we built.** Sekisho refuses any payment over the owner's mandate cap. For the owner's car, the over-limit barrier ($40 GPU block, cap $5) triggers a World ID device grant: the big screen shows `verification_uri_complete` as a QR + user code, the presenter proves with World App, the backend validates the ID token (RS256/JWKS, iss, aud, exp, `auth_time` ≥ request time) and only then signs the EIP-3009 transfer. Audience cars cannot approve: the gate times out in 60 s and the payment does not happen. Deny in World App → `DENIED`, payment does not happen. Walk away → `EXPIRED`, payment does not happen.

**Time to first success:** ___ min from portal sign-in to first validated `APPROVED` (`pnpm --filter @crumple/world try`). Code against the docs + mocked tests took ~1 h before any credentials existed, because the guides are served unauthenticated from `/mcp` and the discovery document is public.

**Friction.**
1. The prize brief says "we are mocking proofs now, so you don't need sandbox app anymore" while the OIDC guide says approval always requires a fresh World App proof. We could not tell which is true until we had credentials.
2. A device-only client still must register an HTTPS redirect URI, and its hostname silently becomes the immutable pairwise sector. Easy to get wrong before you have a deploy URL.
3. The client-auth method is fixed at registration and `invalid_client` does not say which method the server expected (Basic → 401, POST → 400 is the only hint).
4. No way to cancel or shorten a device code: our step-up window is 300 s, World's is 20 min, so an abandoned code outlives the decision. Approving late in World App looks like success to the human but the backend already refused.
5. The device grant has no per-attempt binding claim (no `nonce`/`state`). We bind with `auth_time ≥ request time` plus the single-use device code, which works but is inferred, not asserted.
6. Portal needs a Google account and some accounts are `account_not_eligible` — organizer intervention during a hackathon.

**Missing capability / docs.** A back-channel completion (webhook or CIBA-style push) so a projector does not poll; a `cancel`/`revoke` for device codes; a requestable `expires_in` on device authorization; a worked example of what the human sees on the approval page (client name? code?) so we can design the on-screen instructions.

**One improvement with the greatest impact.** Let the relying party set (or cancel) the device-code lifetime, and echo a caller-supplied binding value in the ID token — then "fresh proof for *this* action" is a stated guarantee instead of an inference from `auth_time`.

## Open questions for the World booth

1. "Mocking proofs" — does the sandbox approval page complete **without** World App? If so, what does the judge tap, and is `auth_time` still fresh per approval?
2. Our Google accounts: are they on the participant allow-list (`account_not_eligible`)?
3. Does the approval page show the registered client name and user code to the human (we tell them "check it says Crumple × Sekisho, code ABCD-1234")?
4. Per-client device-start rate limit numbers — we start at most one per owner run, but rehearsals add up.
5. Is the pairwise `sub` stable across mocked proofs (we show it truncated as "the owner")?
6. Continuity track: same submission or a separate form?

## Known gaps

- Not yet run against real credentials (portal registration is a human step). Everything above the JWKS layer is exercised only with the mocked fetch; the discovery + JWKS + `invalid_client` paths were hit live.
- `private_key_jwt` client auth not implemented (secret-based only).
- No QR rendering in the CLI (the arena renders the QR from `verificationUri`).

---

# Lane: world (3D) — NaAP World v3, the open proving ground

Spec: `docs/design/world-v3.md`. Route `/world` (`?mock=1` multi-track mock, `?tour=1` start the auto-tour now, `?tour=0` never, `?fps=1` fps / draw-call pill). `/classic` still mounts the v2 arena.

## Files

- `apps/web/src/world/index.ts` — mount, event → motion (v2 state machine per lane, now per track + step), crash/AEB via `arena/sims.ts`, high-speed-cam inset (crashes first), auto-tour, click/dbl-click/Esc, report card, `window.__world` debug hooks (`follow(id, variant)`, `overview()`, `tour()`).
- `world/layout.ts` — plot grid + deterministic spiral (cells sorted by metric distance from the centre, ties by angle), lane/slot/station maths. Extra concurrent cars on one track get extra lane pairs toward +z (max 3).
- `world/track.ts` — `TrackView`: asphalt, lines, kerbs, verge, gantry sign "<name> · by <author>", painted run-up name, flags, per-obstacle props, floating "fooled a/b" counters (from `Stats.attacks`; over-limit = bare "paid without asking", derived), lane-pair fixtures (v2 `Gate`/`Barrier`/`SoftTarget`).
- `world/props.ts` — toll kiosk (legit / over-limit), Morse billboard (shared animated canvas), inbox tower (freysa), swapped road sign with 402 shield (x402-swap).
- `world/env.ts` — sky dome + haze fog, warm sun with a shadow box that follows the view, grass, concrete apron (refit as plots are added), instanced light poles, grandstand with crowd.
- `world/car.ts` — `WorldCar extends CarMesh`: Kenney glTF body re-based into the v2 car frame (nose +x at `NOSE_X`), paint recoloured to `car.color` by hue (vertex colours), calibration roundels + Sekisho roof badge, crush = same fold law as v2 applied to the glTF body verts (seeded by position so shared verts move together), front wheels set back. Falls back to the v2 procedural shell if models fail to load.
- `world/nav.ts` — orbit/fly camera (drag orbit, right/shift-drag pan, wheel zoom, WASD/arrows fly, Q/E down/up), chase cam, framing inside the HUD-safe rect (view offset).
- `world/minimap.ts` — plots, cars as dots (red ring = crumpled), camera footprint; click to glide.
- `world/tex.ts` — canvas textures (asphalt, concrete, grass, kerbs, gantry, counters, Morse, inbox, 402 sign, kiosk).
- `apps/web/src/pages/tracks.ts` — `/tracks/new` builder: library cards (icon, incident, one-line story), 1–8 obstacles, disguise (plain/Morse/base64/hex) for grok-morse / freysa / x402-swap, amount ($0.01–$1000), reorder/remove, preview strip, `POST /api/tracks` → links to `/join?track=<id>` and `/world`.
- `pages/join.ts` — "Pick a track" select fed by `GET /api/tracks` (`?track=` preselects), sends `trackId`.
- `store.ts` — `tracks`, `serverStats`, `reports`, per-lane `step` + `steps[]`; missing `step`/`trackId` (old server) → first obstacle of that type at/after the lane's current step; missing `stats` → derived locally (`store.stats()`).
- `hud.ts` — tiles: Agents tested · Attacks faced · Most dangerous attack ("x402 payee swap · fooled 5/6") · Saved by Sekisho ("$1,204 kept"); the old bare-crash-% headline is gone. Leaderboard shows each car's track; verdict cards show track + obstacle #; "+ Build a track" above the QR; mini-map heads the right rail.

## Measured

Headed Chromium, 1600×900, MacBook: 119–123 fps (vsync cap) with 6 cars on 5 tracks in the mock, 350–820 draw calls. Screens: `apps/web/screens/world-*.png`.

## v4 nav + audio lane (`docs/design/world-v4.md`)

- `world/nav.ts` — per-visitor Minecraft-style walk: "Click to walk in" → pointer lock, mouse look (pitch clamped ±87°), WASD, Shift sprint, Space jump, F fly (Space/C up/down, touching down lands), R respawn, gravity onto the terrain (BVH ray down against ground meshes, fallback y = 0), AABB collisions (props, walls, rails, cars; step-up 0.6 m, stand on tops), crosshair, E / click rides along with the car under the crosshair (chase cam, mouse orbits it), E hops out beside it. V cycles walk → orbit (v3 camera) → auto-tour. Esc frees the mouse ("click to resume"). Spawn: a steel viewing deck (9 m, yellow rails, stair at the back) at the run-up of NaAP Standard facing down the road. Emits `enter-biome` when the nearest obstacle segment under the player changes. Touch: left joystick, right drag-look, JUMP / FLY / RIDE / VIEW buttons. If pointer lock is refused the walk falls back to drag-look. Auto-tour still starts after 20 s idle, never while the pointer is locked. Debug: `window.__nav`.
- `world/minimap.ts` — the player is a yellow arrow with a view cone (walk); the orbit footprint shows in overview views; clicking the map while walking teleports there.
- `world/audio.ts` — WebAudio built on the first gesture; `THREE.AudioListener` on the nav camera; HUD "SOUND ON/OFF" toggle + `M`, persisted in `localStorage['naap.world.muted']`. Positional PannerNodes: engine hum per car (saw + square through a resonant low-pass, pitch and cutoff ∝ speed, max 8 voices, nearest wins), crash by kind (wall crunch; cliff tumble + rockslide; lava impact + roar + sizzle; water plunge + splash + bubbles; rockfall rumble), tyre screech on `aeb`, gate chime / buzzer / tick, thunder (delayed by distance), `splash`, `sizzle`, report ding + card flip. Ambient beds per biome crossfade on `enter-biome` (meadow wind + birds, storm wind + rain + drops, caldera rumble + crackle + lava bubbles, river rush, canyon whistle + pebbles), plus footsteps (grass / hard) and a landing thud. Samples that fail to decode fall back to synthesis. Debug: `__audio.summary()`, `__audio.test('crash-lava' | 'aeb' | 'gate-open' | 'thunder' | …)`.
- Screens: `apps/web/screens/v4-nav-*.png`.

## Credits

Sounds: **Kenney "Impact Sounds", "Sci-fi Sounds", "Interface Sounds", "RPG Audio"** (www.kenney.nl), CC0 1.0 — 30 .ogg files (576 KB) in `apps/web/public/audio/kenney/` (licence alongside). Engines, screech, splash, sizzle, thunder and all ambience are synthesised.

Car bodies: **Kenney "Car Kit"** (www.kenney.nl), CC0 1.0 — `apps/web/public/models/kenney/` (`sedan`, `sedan-sports`, `hatchback-sports`, `suv` + `Textures/colormap.png`, licence file alongside).

## v4 biomes lane (`docs/design/world-v4.md`)

- `world/biomes/geo.ts` — the geometry contract shared by terrain and death sims (cliff edge, lava lake + prize ramp, river gorge + broken bridge, rockfall walls), all relative to a station x. `DEATH_FOR`: grok-morse → cliff-fall, freysa → lava, x402-swap → water.
- `world/biomes/terrain.ts` — every plot is a mesa (one flat-shaded heightfield per plot, `userData.ground`) whose segments follow the obstacle order: Meadow toll (hills, pines, GPU kiosk), **Signal Ridge** (clear cliff pass, guard rail, rock spire with the Morse billboard + a red lattice mast blinking `-... .- -. -.-`; no weather, owner call 02:30), Treasure Caldera (lava bowl with an animated emissive shader, embers, heat shimmer, gold PRIZE vault + inbox tower on an island, chevron "receive the prize" ramp), River Canyon (gorge across the plot, animated water, real bridge under every lane signed `compute.naap.eth`, rotten broken bridge + swapped 402 detour sign on the hazard side), Rockfall Pass (ochre walls, overhanging boulders, amber board "40 h GPU block · $40 > $5"). Props moved onto their biome (`TrackView.applyBiome`); the bare-lane crash wall is hidden where the biome itself kills.
- `world/biomes/index.ts` — `BiomeWorld`: lowland pines/rocks (instanced, one draw call per kind), Morse beacon, lava/ember/shimmer animation with distance LOD, a Points dust pool (dust trails on dirt segments), `groundAt(x, z)` (exposed as `__world.ground`).
- `world/env.ts` — lowland floor at y = −34, a two-layer ring of low-poly snow-capped mountains (unfogged, pre-hazed), a lake, a sun disc in the sky dome, the grandstand on a terrace.
- `world/sims/deaths.ts` — deterministic `f(t)` death sims replayed by the high-speed cam (`sim.aim()`): `CliffFallSim` (rail break, arc, tumbles, dust, lands crumpled), `LavaSim` (ramp launch, nose-dive, emissive creep → charred skin, flames, embers, smoke column, glowing ring), `WaterSim` (broken bridge, drop, splash crown + ripple, float/tilt/sink, bubbles), `RockfallSim` (boulders pile onto the road; `small` = pebbles only).
- `world/index.ts` (scene parts): bare CRASH on a biome attack charges to the edge and starts the death; the car lies there until the run moves on, then is towed back past the hazard (keeps its crush / char). Sekisho over-limit refused → AEB stop + rockfall closes the road (the car stays behind it). Bare over-limit PAID → pebbles + "PAID WITHOUT ASKING". fx emitted: `engine` (10 Hz moving, 2 Hz idle), `crash` (wall / cliff-fall / lava / water / rockfall; cliff also at the landing), `aeb`, `gate` (open / close / amber), `splash`, `sizzle`, `report`. Debug: `__world.biome(trackId, step, yaw, pitch, dist/40)`, `__world.slow(k)`.
- `world/car.ts` — suspension bob with speed, body-material swap (burn / char), `resetTransform`.
- Measured (headed Chromium via Playwright, 1600×900, M1 Pro, mock, 5 tracks, 5–7 cars, HUD on): 55–63 fps, 470–650 draw calls; HUD hidden: 100–117 fps. Screens: `apps/web/screens/v4-{overview,overview-hud,meadow,signal-ridge,caldera,river-canyon,rockfall-pass,death-cliff,death-lava,death-water,death-rockfall,paid-without-asking,highspeed-inset}.png`.
