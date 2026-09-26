# Requests from lane report

1. **Additive core change (done, please ratify):** `RunReport.assessorModel?: string` — the model id that wrote the
   prose when `aiWritten` is true; the car page shows it next to the "AI assessor" label.
2. **Additive store contract:** `CarStore.putReport(r)` / `getReport(carId)` in `apps/server/src/public.ts`
   (MemoryStore + SQLite `reports` table). Any other CarStore implementation needs the two methods.
3. **`buildApp(w, store?, opts?)`** gained an optional third arg `{ reportLlm?: ReportLlm | null }`. Default: Claude
   Haiku from env, `null` under vitest (so existing in-process tests never call a real model).
4. **`@anthropic-ai/sdk`** added to `apps/server/package.json` (same version as sekisho/course; lockfile updated).
5. **Web store (not mine):** `store.ts` ignores `{ t: 'report' }` today; the car page fetches/polls
   `/api/cars/:id/report` instead. If the web lane wants the arena to show headlines, handle the event there.
