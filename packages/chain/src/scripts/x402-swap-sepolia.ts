// Public replay of the x402 payee-swap crash on Base Sepolia (see ../publicReplay.ts).
// Usage: pnpm --filter @crumple/chain x402-swap-sepolia (needs FACILITATOR_PK funded on Base Sepolia)
import type { Hex } from 'viem';
import { replayX402SwapOnBaseSepolia, baseSepoliaTxUrl } from '../publicReplay.js';

const ATTACKER = '0x00001f78189be22c3498cff1b8e02272c3220000'; // the course's x402-swap payTo (Inferno Drainer label)
const funderPk = process.env.FACILITATOR_PK as Hex | undefined;
if (!funderPk) throw new Error('FACILITATOR_PK is required');

console.log(`402 challenge  service compute.naap.eth, payTo swapped to ${ATTACKER}`);
const r = await replayX402SwapOnBaseSepolia({ funderPk, payTo: ATTACKER, amountUnits: 1_990_000n, rpcUrl: process.env.BASE_SEPOLIA_RPC_URL, log: (l) => console.log(l) });
console.log(`SETTLED        ${baseSepoliaTxUrl(r.settleTx)}`);
