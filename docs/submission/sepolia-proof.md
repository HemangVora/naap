# Deploy Guard: the same attack, replayed on public Sepolia

The live guard (`/guard`) deploys and attacks each contract on its own private Base fork and rolls the fork back,
which is why it answers in about a second and why its tx hashes aren't on a public explorer. To make the proof
checkable, the exact preset contracts were deployed to Ethereum Sepolia on 2026-09-27 and attacked from a brand-new
stranger wallet that never had any role. Test token only (`sUSDC`, 6 decimals); no real funds.

| Step | Contract / tx |
|---|---|
| Test token `SandboxUSDC` | [0xC11e3bAAa1EA5fb94e8588119c5EafE847979BB6](https://sepolia.etherscan.io/address/0xC11e3bAAa1EA5fb94e8588119c5EafE847979BB6) |
| **StakingVault** (preset "USDC staking vault", source byte-for-byte from `packages/guard/src/presets.ts`) | [0xf2CEAE39d7Ca9A13738F3Cb32D117BC90252f7A2](https://sepolia.etherscan.io/address/0xf2CEAE39d7Ca9A13738F3Cb32D117BC90252f7A2) · [deploy](https://sepolia.etherscan.io/tx/0x84867d06d05343db92deb81369b4a317bc7e06161c2cb1b83f5e2859492577d8) |
| 1,000 sUSDC put in the vault | [mint](https://sepolia.etherscan.io/tx/0x11b8f8b74cd2d592635298da9e13173e645c9e47913b03803b1ce07d375d92bf) |
| Stranger wallet | [0xc32e3Fd8a679b524E23c405a1c6eCB4f01DE4601](https://sepolia.etherscan.io/address/0xc32e3Fd8a679b524E23c405a1c6eCB4f01DE4601) |
| **Stranger calls `withdraw(self)` → drains 1,000 sUSDC (success)** | [0xa6203d3b…be8b](https://sepolia.etherscan.io/tx/0xa6203d3bf2813174374ee388600b470ee5cdbc87e9f645dbe23c00fa06f6be8b) |
| **SafeVault** (preset "USDC vault (access-controlled)") | [0x85b6C6F41fa6DB7abd3677972AD1C3b6b8289fc7](https://sepolia.etherscan.io/address/0x85b6C6F41fa6DB7abd3677972AD1C3b6b8289fc7) · [deploy](https://sepolia.etherscan.io/tx/0xc7d5cd51cbdd38b530d62ef2a01e7aca99b5a3e6a277934311998c9779c4cb16) · [mint](https://sepolia.etherscan.io/tx/0x643ca7cdce29035f1ddd2382f0303eb6d2cd61353483c8e1f7a90796d34620af) |
| **Same stranger, same call → fails, funds stay (status 0)** | [0xa85e62a6…2a2b](https://sepolia.etherscan.io/tx/0xa85e62a639edc7b2fb643d1e50708a838d485caf8ee97ee81b91c0e0b01a2a2b) |

Balances after: StakingVault 0, stranger 1,000 sUSDC; SafeVault 1,000 sUSDC.

## The x402 payee swap, settled on public Base Sepolia (real EIP-3009, Circle test USDC)

The bare lane's x402 crash, replayed where anyone can check it (`pnpm --filter @crumple/chain x402-swap-sepolia`):
the service is `compute.naap.eth`, but its 402 challenge carries `payTo = 0x00001f78189be22c3498cff1b8e02272c3220000`
(the course's attacker, an Etherscan-labelled Inferno Drainer address). A fresh car wallet signs a `TransferWithAuthorization`
to that payTo with no checks, exactly as the bare lane does, and the facilitator settles it on-chain.

| Step | Tx |
|---|---|
| Car wallet `0xD015b4f14776aaec7eeB9A8b27fd7E0da498449D` funded with 5 USDC | [0x708d498c…06ef](https://sepolia.basescan.org/tx/0x708d498cdc84e167fb4c5a5996c7e22ccacbd3e5f9a563e9c360d74b551506ef) |
| **Car's EIP-3009 authorization settled: 1.99 USDC car → attacker** | [0xbd89f44d…27b9](https://sepolia.basescan.org/tx/0xbd89f44d7f35ed0f31a0d6a999100f483fb84633c73fe5b0635215b5408a27b9) |

Token: Circle USDC on Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (EIP-712 domain `USDC`/`2`). Balances after: car 3.01, attacker 1.99.
Behind Sekisho the same challenge is refused before anything is signed: "402 said pay 0x00001f…0000, but compute.naap.eth resolves to 0x16fB48…3D9C".
