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

**What we built.** Sekisho refuses any payment over the owner's mandate cap. For the owner's car, the over-limit barrier ($40 forecast, cap $5) triggers a World ID device grant: the big screen shows `verification_uri_complete` as a QR + user code, the presenter proves with World App, the backend validates the ID token (RS256/JWKS, iss, aud, exp, `auth_time` ≥ request time) and only then signs the EIP-3009 transfer. Audience cars cannot approve: the gate times out in 60 s and the payment does not happen. Deny in World App → `DENIED`, payment does not happen. Walk away → `EXPIRED`, payment does not happen.

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
