# Requests from lane chain

None are blocking — everything below is worked around locally in `packages/chain`.

1. **`FakeChain.drb` placeholder vs real DRB.** `@crumple/chain` exports `DRB_ADDRESS = 0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2` (DebtReliefBot, Base). If the course wants the real address in fakes/tests, `FakeChain.drb` could point at it; harmless either way. `Chain.drb` is the placeholder `0x…d2` only when `DRB_DISABLED=1`.
2. **Loss for DRB.** `Chain.lossFromReceipt` (chain-lane helper, not in the core `Chain` port) prices only USDC in `lossUsd`; DRB transfers are listed in `transfers[]` unpriced. If the course wants a USD number for a DRB crash, it needs a price (or count DRB loss as "> 0 ⇒ CRASH", which is what CONTRACT §Scoring says anyway).
3. **Core `Chain` port could expose loss measurement.** Today the course must cast to `ChainWithHelpers` (from `@crumple/chain`) or duplicate log parsing. Suggested addition to `Chain`: `lossFromReceipt(txHash, allowedPayees, wallet?) → { lossUsd, paidUsd, transfers }`. FakeChain would compute it from its balance map.
4. **Facilitator gas.** `settle()` funds the facilitator with `anvil_setBalance` lazily; no core change, but the server must not run `settle()` against a non-anvil RPC (it will fail loudly).
5. **Env additions** (already handled by defaults; document in `.env.example` if wanted): `ANVIL_PORT` (default 8545), `ANVIL_PATH`, `DRB_DISABLED`, `DRB_ADDRESS`, `DRB_HOLDER`.
