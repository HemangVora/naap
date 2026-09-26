# Requests from lane ens (non-blocking — worked around locally)

1. **`ArenaEvent` `mandate.onchain`** — `{ t:'mandate.onchain'; carId; ensName; txHash }`, mirroring `rating.onchain`, so the
   arena can flip the car's ENS badge from "pending" to "✓ on ENS" when the mandate write lands. Workaround: the ens source
   exposes `onConfirmed(cb)` / `whenConfirmed(name)`; the server can emit whatever it likes from that.
2. **`Mandate.source` while pending** — `createForCar` returns `source:'local'` until the Sepolia write is mined (a few
   blocks). The UI should treat that as "pending on ENS" rather than "offline" when `ENS_MODE=ens`; `status(name)` returns
   `'pending' | 'confirmed' | 'failed'` to tell them apart.
3. **`createRatingWriter` signature** — I take the mandate source (`createRatingWriter(source)`) instead of a raw cfg so both
   share the single relayer nonce queue. Server wiring: `const mandates = await createMandateSource(); const ratings = createRatingWriter(mandates);`.
4. **Funding** — the relayer `0xf78456BcfA81189fd7558DdeaA6c8C68075700f7` needs ≥ 0.1 Sepolia ETH before `register` can run
   (RELAYER_PK already in `.env`).
