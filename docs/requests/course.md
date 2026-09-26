# Requests from lane course

1. **`SessionState.tripwire?: TripwireResult[]`** (types.ts) — the course runs `deps.tripwire.assess` on every content item before
   Sekisho, but can only hand the result to Sekisho as trace lines. With a field on `SessionState`, Sekisho's `JEV_TRIPWIRE`
   check can use the real escalation instead of re-running Jev. Workaround in place: course emits `trace` lines `who:'tripwire'`
   and Sekisho may call Jev itself.
2. **`RunDeps.driverFor` return type** — course's `driverFor` returns `CourseDriver` (`CarDriver` + `kind` + `offline`). Server can
   read `.offline` for the "offline" pill; no core change needed, but if the server wants it typed, add `offline?: boolean` to `CarDriver`.
3. **`ArenaEvent 'headline'`** — course provides `computeHeadline(ratings)`; the server owns the ratings list, so it emits the event.
4. **DRB** — `Chain.balanceUsd` is USDC only, so a DRB drain would not show as loss. If lane chain lands DRB, add a `balanceOf(token)` to `Chain`.
