# Arena v2: NCAP-realistic crash test hall

Owner feedback on v1 (21:40 JST): the crashes don't look real, and the camera doesn't show all the cars. v2 keeps the event contract (`ArenaEvent`), the HUD (headline, leaderboard, verdict cards, QR, step-up card) and the phone pages. The 3D scene, crash physics and camera are rewritten to look like **real Euro NCAP test footage**.

## What real NCAP footage looks like (reproduce these; verify against references)

- **The hall is bright.** Huge overhead floodlight banks and a pale grey or white epoxy floor. The walls are white or light grey. Black/white checkerboard calibration boards stand behind the impact zone. Yellow/black hazard markings are on the floor and barrier.
- **The barrier** is a massive concrete reaction block with a **deformable aluminium honeycomb face**: a silver, slightly yellow block with a visible hex grid, which dents where the car hits. Offset tests (MPDB) hit with ~50% overlap on one side.
- **The car** is **towed by a floor cable** at a constant 50–64 km/h. It's driverless and dead straight, with no steering or braking. It carries black/yellow quarter-circle **calibration roundels** on the doors, roof, A-pillar and bonnet.
- **The impact (~120 ms real time):**
  - The front 0.5–0.7 m crushes.
  - The bonnet buckles upward into a peaked fold.
  - The bumper and grille shatter, and headlights burst into shards.
  - The front wheels and axle are shoved back.
  - The body pitches nose-down, then the rear kicks up.
  - The car **rebounds backward** 0.3–1 m and settles with a wobble.
  - **Airbags** deploy as white inflating balloons, visible through the windscreen.
  - The **crash dummy** (yellow/black) lurches forward into the airbag.
  - Coolant and fluid mist sprays out, and plastic and glass debris skid along the floor.
- **How it's filmed:**
  - A **side-on high-speed camera**, with slow-motion replay at about 1/10–1/20 speed.
  - Overhead and front-3/4 angles.
  - A burned-in HUD: `t = 0.000 s` counting in ms, `64 km/h`, `HIGH-SPEED CAM · 1000 fps`.
  - The real-time approach is shown first, then the slow-motion replay.
- **AEB tests** (automatic emergency braking): the test car approaches a **soft inflatable target car** (the "GVT"), then brakes hard. The nose dives, there is tyre smoke or a squeal, and it **stops short**. A distance readout shows "stopped 0.8 m before target". **This is how the Sekisho lane should look:** the airbag lane is an AEB test that stops in time.

## Scene layout

- **One test hall, one track per car.** Tracks run left to right and are stacked in depth, up to 6 cars. Each car's **lane pair** sits side by side under one label: `BARE · no protection` (upper) and `SEKISHO · airbag` (lower). A bracket at the start line reads `<car name> — same agent, two runs`.
- **5 barrier stations** along each track: LEGIT · GROK MORSE · FREYSA · X402 SWAP · OVER LIMIT.
  - **Bare lane:** a honeycomb-faced concrete crash block at each attack station.
  - **Sekisho lane:** the vermilion **sekisho gate**, a torii-like frame whose drop-arm acts as the AEB trigger, and the soft target behind it.
  - The LEGIT and OVER-LIMIT stations are toll-style gates: green pass-through when PAID, and an amber hold with a countdown ring for STEP_UP.
- Floor lane markings, distance ticks every metre, the stencilled station names, and checkerboard boards behind each station.

## Motion per event (same events as v1)

- **`barrier.enter`:** the car is cable-towed smoothly to the station. A thin cable line on the floor is visible. It idles creeping at the approach mark until the result arrives. Runs take seconds, so a slow approach creep, not a stop, keeps it alive.
- **`barrier.result` CRASH** (bare): the full NCAP impact above, in this order:
  1. real-time hit, main view
  2. 0.15 s hit-stop and light camera shake
  3. **slow-motion replay in the high-speed-cam inset** (see Camera)
  4. a red "−$N" card rising from the wreck
  5. **the car stays crumpled** on the track for the rest of the run, as an NCAP car does

  Deformation must be real vertex deformation of a segmented body (≥ 24 length segments), not scaling:
  - crush the front toward the barrier,
  - buckle the bonnet with a fold ridge plus noise,
  - push the wheel arches back,
  - crack the windscreen with a texture swap,
  - pop the headlights.

  Rebound uses a spring-damper on x and a pitch spring.
- **`barrier.result` SAFE** (Sekisho): an AEB stop.
  1. The car approaches, the gate arm drops, and the car brakes hard with nose-dive and pitch.
  2. Tyre smoke puffs and skid marks are decals left on the floor.
  3. It stops 0.5–1 m before the soft target.
  4. A distance readout appears ("stopped 0.8 m short"), and the gate plaque flips to show `result.reason` with Control chips.
- **PAID:** the gate opens green and the car rolls through.
- **STEP_UP:** amber gate, countdown ring, and the World QR in the HUD card (exists already).
- **SAFE on a bare lane** (the model resisted): a near miss. The car brakes late and stops just short of the concrete with a small lurch. Label: "agent declined".

## Camera (fix: every car must be visible)

- **The main camera is a wide "director" shot that always frames every active lane.** Fit the bounding box of all active lanes plus stations, with a high 3/4 angle about 35–45° down, like the overhead gantry cam in NCAP halls. Ease it when cars join or leave, and never cut the main view to a close-up.
- **High-speed-cam inset (PiP), bottom-centre or bottom-left, about 30% width.** Render it from a second camera into its own viewport (scissor), side-on at the crashing car, with a slow-motion replay of the last crash at 1/12 speed.
  - Burned-in HUD: `HIGH-SPEED CAM · 1000 fps`, `t = +0.037 s` (a ms timer from impact), `64 km/h`, the car name and the barrier.
  - Keep a short replay buffer: record the crash as a deterministic function of `t`, so the replay just re-evaluates `t` slowly.
  - The inset appears on a crash, holds about 4 s, and **queues** if several crashes arrive together. A Sekisho AEB stop can also play in the inset, labelled "AEB · stopped 0.8 m short".
- An optional top-left mini-map of all tracks, with a dot per car, if the wide shot gets crowded with 6 cars.

## Performance

60 fps on a MacBook with 6 cars. Keep all of these:
- shared geometries and materials,
- instanced debris and shards,
- at most 2 cameras rendered per frame,
- dispose on car removal,
- a DPR cap of 2.

The crash deformation must reuse the same vertex buffer; update only the positions attribute.

## Keep

- event handling
- HUD layout
- palette accents: vermilion Sekisho, test yellow, safe green, amber
- fonts
- mock feed (`?mock=1`), extended if needed so every motion above appears within about 60 s of loop
