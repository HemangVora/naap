# Requests from lane intercepta

1. **PAYEE_SEED derivation (legacy name WEATHER_SEED) (lane chain / sekisho / ens).** `@crumple/intercepta` derives the compute payee as
   `privateKeyToAccount(keccak256(toBytes(PAYEE_SEED)))` (or uses the seed directly when it is a 0x 32-byte hex).
   Anyone who needs the same address/key (x402 seller helper, `compute.naap.eth` resolution) should import
   `payeeAddress()` / `payeeAccount()` from `@crumple/intercepta` rather than re-deriving. Worked around locally: exported both.

2. **`ScreenResult` extra fields (core, optional).** My results carry `reason`, `source: 'live'|'cache'|'fixture'|'fake'`,
   `endpoint`, `error` on top of the frozen shape (`InterceptaScreenResult extends ScreenResult`). The UI "Intercepta offline"
   pill can use `live:false`; the plaque reason can use `reason` (== first `traits[].description`). No core change needed
   unless you want the fields in the type.

3. **`.env`:** `INTERCEPTA_API_KEY` and `PAYEE_SEED` (or legacy `WEATHER_SEED`) are still empty at 19:00 JST. Please fill them and run
   `pnpm --filter @crumple/intercepta probe` (≈6 requests) so `verified` flips to true before the 02:00 live run.
