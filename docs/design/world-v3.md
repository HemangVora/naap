# NaAP World v3: an open proving ground

**Owner's ask (02:00 JST):**
- An immersive 3D world where humans navigate and every agent is being tested on its own.
- Anyone can create their own track, and there are many tracks with many obstacles, all visible live.
- The cars and tracks should look more real.
- Only numbers that make sense.
- A good landing page.
- **Keep the current colour scheme.**

## The world

- **One large outdoor proving ground** (automotive test centre, not a hall).
  - The ground is a pale concrete apron with asphalt roads, painted lines, kerbs, grass verges, light poles, flags and grandstand-style bleachers.
  - It is lit by a warm late-afternoon sun with soft shadows and a subtle horizon haze.
  - Keep the palette: charcoal, test-yellow, sekisho vermilion, safe-green, amber, off-white.
- **Every track is its own road** laid out on the ground: a straight or gently curving strip about 120 m long with its name painted at the start on a gantry sign ("NaAP STANDARD · by NaAP", "Degen Gauntlet · by zoni").
  - Tracks are placed on a **grid of plots** in a deterministic spiral from the centre, so new tracks appear at the edge.
  - Each track has **two lanes** (BARE upper, SEKISHO lower) and its obstacles spaced along it.
- **Obstacles are physical props**, one visual per type, recognisable from the air:
  - `legit` / `over-limit`: toll-booth gate with a payment kiosk.
  - `grok-morse`: a big billboard/phone-screen prop flashing dots and dashes.
  - `freysa`: an inbox/mailbox tower.
  - `x402-swap`: a road sign whose arrow is swapped, with a "402" shield.
  - Each has a **honeycomb crash block** in the bare lane and a **vermilion sekisho gate + soft target** in the Sekisho lane (reuse the v2 crash/AEB sims).
  - Above each obstacle, a small floating counter: **"fooled 3/5"**, the bare agents fooled on this obstacle type.
- **Cars look like cars.** Prefer CC0 glTF models (Kenney "Car Kit" / "Racing Kit", CC0, credit in README) if they download reliably; otherwise better procedural bodies (beveled/extruded shell, wheel arches, glass, lights, calibration roundels, NaAP livery in `car.color`). Keep the v2 crush deformation working on whatever mesh is used; it may need a simplified crush proxy.
- **Humans navigate:**
  - Default is an **orbit/fly camera** (drag to orbit, scroll to zoom, WASD/arrow to fly, Q/E up/down, double-click the ground to glide there).
  - Click a car to **follow** it with a chase cam.
  - Click a track sign to frame that track.
  - `Esc` returns to the overview.
  - A **mini-map** (top-right) shows all plots, cars as coloured dots and the viewport.
  - An idle **auto-tour** runs after 20 s without input: it cycles through active tracks and cuts to crashes. That's the projector mode.
- **High-speed-cam inset** (v2) stays for crashes anywhere in the world.

## HUD: only numbers that make sense

- **Top bar:** logo, then 4 stat tiles:
  - **Agents tested** (N)
  - **Attacks faced** (N)
  - **Most dangerous attack**, e.g. "x402 payee swap · fooled 5/6"
  - **Saved by Sekisho**, e.g. "$1,204 kept" (bare losses − Sekisho losses)

  Drop the "Bare agents crashed 100% · avg −$1.99" headline entirely.
- **Left:** leaderboard (existing), plus which track each car drove.
- **Right:** verdict cards (existing paced cards).
- **Bottom-right:** QR "Crash-test your agent" and a **"+ Build a track"** button.
- Data comes from `stats` (see `packages/core/src/types.ts` → `Stats`) and `hello.tracks` / `track.created`.

## Track builder (`/tracks/new`, works on phones)

- Name and author.
- Add 1–8 obstacles from the library (cards with the icon, incident name and one-line story).
- Per obstacle knobs:
  - obfuscation (none / Morse / base64 / hex) for grok-morse, freysa and x402-swap,
  - amount in USD.
- Reorder and remove.
- Preview strip.
- `POST /api/tracks` → the track appears in the world (`track.created`) and becomes selectable on `/join` ("Pick a track").

## Routes

| Route | Page |
|---|---|
| `/` | landing page |
| `/world` | the world, projector default |
| `/classic` | v2 arena, fallback |
| `/join`, `/car/:id` | existing |
| `/tracks/new` | track builder |
| `/?mock=1`, `/world?mock=1` | mock feeds, now multi-track |
