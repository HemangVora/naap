# Requests from lane web

1. **SPA fallback (server).** `/join` and `/car/:id` are client routes in one `index.html`. Please serve `apps/web/dist/index.html` for any GET that is not `/api/*`, `/ws`, `/x402/*` or an existing asset. Worked around locally by Vite's `appType: 'spa'`.

2. **Owner token on `POST /api/cars`.** CarSpec has no token field, so `/join?owner=<token>` sends it as `?owner=<token>` query string AND an `x-owner-token` header, with `isOwnerCar: true` in the body. Pick one and ignore the other; a mismatch should 403.

3. **Done: `hello.integrations`** — used for the offline pills. Thanks.

4. **Nice to have:** a `stepup.pending` for audience cars still carries `expiresAt`; we draw the countdown from it. Keep it.
