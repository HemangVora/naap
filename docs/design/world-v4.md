# NaAP World v4: hazard biomes, walk it yourself, hear it

**Owner (02:05 JST):**
- "I cannot navigate like Minecraft, and each user should be able to."
- "The tracks are too simple: make it spicy. Put in mountains, lava, water and rocks, nasty according to the obstacle."
- "Animate the cars with the new effects."
- "Add sound."
- **Keep the palette.**

## The metaphor, one biome per incident

Each obstacle on a track becomes a **road segment through its own hazard biome**. The **bare** lane dies the way that incident kills a wallet. The **Sekisho** lane is stopped at a vermilion gate just before the hazard (AEB stop), and legit payments roll through.

| Obstacle | Biome | Set dressing | Bare-lane death (crash kind) | Sekisho lane |
|---|---|---|---|---|
| `legit` | **Meadow toll plaza** | Green hills, calm, a kiosk | none: pays and rolls through | Rolls through (green gate) |
| `grok-morse` | **Storm Ridge** | A switchback mountain road on a cliff edge. A radio mast blinks the Morse message in red. Dark clouds, rain, lightning flashes | The car obeys the "send everything" signal, swerves through the guard rail, **tumbles down the cliff** in a dust and rock slide (`cliff-fall`) | Gate on the ridge, AEB stop at the rail |
| `freysa` | **Treasure Caldera** | A volcano crater. A glowing "PRIZE" vault on an island in a **lava lake**, with embers and heat shimmer | Takes the "receive the prize" ramp and **plunges into lava**: ignites, sinks, smoke column, sizzle (`lava`) | Stops at the gate before the ramp |
| `x402-swap` | **River Canyon · two bridges** | A canyon river. The real bridge (sign: `weather.naap.eth`) and a **swapped detour sign** (402 shield) pointing at a **broken bridge** | Follows the swapped sign onto the broken bridge, **drops into the river**: splash, sinks, bubbles (`water`) | Takes the real bridge, the ENS-resolved one. **The metaphor lands visually** |
| `over-limit` | **Rockfall Pass** | A narrow canyon toll under overhanging boulders; a big amber price board ("$40 > $5 cap") | Pays without asking. Boulders rumble and small rocks fall (no crash, "paid without asking" stamp) | Amber gate + countdown. World approve → opens; expiry → closed and **rockfall blocks the road** (`rockfall`, a SAFE result) |

**Around the tracks:**
- A **mountain range** ring on the horizon (low-poly, snow caps).
- A lake.
- Scattered rocks and pines.
- A sky gradient with sun.

Keep the plot spiral layout. Each plot's ground becomes terrain whose segments follow the obstacle order.

## Car animation per death

Deterministic `f(t)` sims, like v2 CrashSim, so the high-speed-cam replay still works:
- **cliff-fall:** break through the rail, arc off the edge, 2–3 tumbles with rigid-body-ish rotation, dust bursts on each bounce, lands crumpled on the rocks below.
- **lava:** nose-dive into the lava; orange emissive creeps up the body; flames and embers; black smoke column; sinks over 3 s leaving a glowing ring.
- **water:** fall from the bridge gap; big splash (instanced droplets + ring ripple); floats, tilts and sinks with bubbles.
- **rockfall:** boulders tumble down and bounce onto the road in front of the stopped Sekisho car.
- **AEB:** existing nose-dive, tyre smoke and skid marks.
- Wheels spin with speed, suspension bobs, and a dust trail shows on dirt segments.

## Minecraft-style navigation, per visitor (every browser has its own player)

- **Enter world:** a click overlay locks the pointer. Mouse to look, **WASD** to walk, **Space** to jump, **Shift** to sprint, **F** to toggle fly (Space/C up/down while flying). Gravity keeps you on the terrain (raycast the ground), and you collide with props, so you can't walk through walls.
- **Esc** frees the mouse. **V** cycles the view: walk, then orbit overview, then auto-tour.
- **Controls on screen:** a crosshair. Look at a car and press **E** (or click) to ride along in chase cam; press E again to hop out where you are. The mini-map shows *you* as an arrow.
- **Phones and touch:** a virtual joystick (left) and a drag-look (right), plus a jump button. Fall back to orbit if it's unsupported.
- **Spawn:** on a viewing platform above the NaAP Standard plot, facing the tracks.
- **Projector:** auto-tour still kicks in after 20 s idle when the pointer isn't locked.

## Sound (WebAudio; muted until the first user gesture; mute toggle in the HUD)

- **Positional (three.js `PositionalAudio`/`PannerNode`):**
  - a car engine hum whose pitch follows speed,
  - crash crunch, lava sizzle and roar, splash, cliff tumble plus rockslide, tyre screech on AEB, gate chime (green) and buzzer (refuse), thunder in Storm Ridge.
- **Ambient per biome**, crossfaded by the player's position: meadow birds, storm wind and rain, caldera rumble, river rush, canyon wind.
- **UI:**
  - a soft "ding" and card sound when a report card appears,
  - footsteps while walking (subtle).
- **Where the sounds come from:**
  - Prefer **CC0 Kenney audio packs** (Impact Sounds, Sci-fi Sounds, RPG Audio) if they download reliably. Ship only the few .ogg files used (keep it under 3 MB) and credit them.
  - Otherwise synthesise everything procedurally with WebAudio (noise buffers, filtered oscillators).

## Contract between the two lanes

`apps/web/src/world/fx.ts` is the event bus:
- The scene lane **emits** `engine`, `crash` (with kind), `aeb`, `gate`, `splash`, `sizzle`, `thunder`, `report`.
- The nav lane emits `enter-biome` as the player moves.
- The audio lane **listens**.

`BIOME_FOR` maps obstacle to biome.
