# Requests from the nav + audio lane (NaAP World v4)

Nothing blocks; each item makes walking and sound better. Integrator / biomes lane decides.

1. **Tag collision meshes (biomes lane).** `world/nav.ts` finds ground and solids by scanning the scene every 1.5 s.
   Tags win over its heuristics:
   - `mesh.userData.ground = true`: terrain, roads, bridges, decks (walkable, never a wall). Big terrain gets a BVH automatically (`three-mesh-bvh`).
   - `mesh.userData.solid = true`: walls, boulders, kiosks, gantry posts, bridge rails (AABB colliders; you can stand on top).
   - `mesh.userData.noCollide = true`: skip (rain, embers, glow rings, decals, sky, water/lava surfaces if you want visitors to sink).
   Untagged, a mesh ≥ 10 m wide and flat (height < 0.35 × width) is ground; anything else ≥ 0.3 m tall and ≤ 40 m wide is solid. Transparent (opacity < 0.6), BackSide and depthWrite:false materials are skipped. Instanced meshes (≤ 2500 instances) are per-instance solids.
2. **Optional exact ground height.** If terrain is a height function, call `nav.setGroundProvider((x, z) => y | null)` from `index.ts`; it replaces the raycast.
3. **Engine events for parked cars.** `engine` is only emitted when `speed > 0.05`; voices fade after 0.7 s without events, so idling cars are silent. Emitting `speed: 0` at ~2 Hz for cars at the start line would give an idle rumble.
4. **Crash position for cliff-fall / water.** The sound plays at the `crash` event position. If the car ends up 20 m below (cliff floor, river), a second `splash` / `crash` at the landing point would place the thud where the eye is.

## Hooks added to `world/index.ts` (nav lane, input/camera section only)

- `nav.attach({ scene, spawn, biomeAt, use, onView, onGesture, onStep, onLand })` right after `nav.onInput`.
- `rideAt(ray)` factored out of the canvas click handler (click and E share it); `pick()` uses the screen centre while the pointer is locked.
- `tour.start/stop` sync `nav.setView('tour' | 'orbit', false)`; Esc in walk view only frees the mouse; `M` toggles sound.
- `const audio = new WorldAudio()` passed to `createHud(..., { sound: audio, hints })`; `audio.attach(nav.camera)`; `minimap.player = () => nav.marker()`.
