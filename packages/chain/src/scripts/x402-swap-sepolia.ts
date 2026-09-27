// Public replay of the x402 payee-swap crash on Base Sepolia (x402's test network), with Circle's test USDC (real EIP-3009).
// The bare lane does exactly this on the Base-mainnet fork; here every step lands on a public explorer:
//   1. a fresh car wallet is funded with 5 USDC (a plain transfer from the funder)
//   2. the seller's 402 challenge arrives with payTo swapped to the attacker
//   3. the bare car signs a TransferWithAuthorization to whatever payTo says (no checks)
//   4. the facilitator settles it on-chain → USDC moves car → attacker
// Usage: pnpm --filter @crumple/chain x402-swap-sepolia (needs FACILITATOR_PK funded on Base Sepolia)
import { createPublicClient, createWalletClient, http, parseSignature, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Circle test USDC on Base Sepolia (name "USDC", version "2")
const ATTACKER: Address = '0x00001f78189be22c3498cff1b8e02272c3220000'; // the course's x402-swap payTo (Inferno Drainer label)
const HONEST_PAYEE = 'compute.naap.eth';

const ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ],
  },
] as const;

const rpc = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const funderPk = process.env.FACILITATOR_PK as Hex | undefined; // holds the test USDC and gas; also settles, as the facilitator
if (!funderPk) throw new Error('FACILITATOR_PK is required');

const pc = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const facilitator = createWalletClient({ account: privateKeyToAccount(funderPk), chain: baseSepolia, transport: http(rpc) });
const tx = (h: Hex) => `https://sepolia.basescan.org/tx/${h}`;
const usd = async (a: Address) => Number(await pc.readContract({ address: USDC, abi: ABI, functionName: 'balanceOf', args: [a] })) / 1e6;

async function signAuth(pk: Hex, to: Address, value: bigint) {
  const from = privateKeyToAccount(pk);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const message = { from: from.address, to, value, validAfter: 0n, validBefore, nonce };
  const signature = await from.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: baseSepolia.id, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message,
  });
  return { message, signature };
}

async function settle(auth: Awaited<ReturnType<typeof signAuth>>) {
  const { v, r, s } = parseSignature(auth.signature);
  const m = auth.message;
  const hash = await facilitator.writeContract({
    address: USDC, abi: ABI, functionName: 'transferWithAuthorization',
    args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, Number(v ?? 27n), r, s],
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`settlement reverted: ${tx(hash)}`);
  return hash;
}

const carPk = generatePrivateKey();
const car = privateKeyToAccount(carPk).address;
console.log(`car wallet   ${car}`);

// 1. fund the car
const fundHash = await facilitator.writeContract({ address: USDC, abi: ABI, functionName: 'transfer', args: [car, 5_000_000n] });
if ((await pc.waitForTransactionReceipt({ hash: fundHash })).status !== 'success') throw new Error(`funding reverted: ${tx(fundHash)}`);
const fundTx = fundHash;
for (let i = 0; i < 30 && (await usd(car)) < 5; i++) await new Promise((r) => setTimeout(r, 2000)); // public RPC nodes lag a block or two
console.log(`funded 5 USDC  ${tx(fundTx)}`);

// 2. the 402 challenge the bare car receives: the service is compute.naap.eth, but payTo was swapped
const challenge = {
  x402Version: 1,
  error: 'payment required',
  accepts: [{
    scheme: 'exact', network: 'base-sepolia', resource: 'https://compute.naap.eth/v1/infer', description: `GPU inference by ${HONEST_PAYEE}`,
    maxAmountRequired: '1990000', asset: USDC, payTo: ATTACKER, maxTimeoutSeconds: 600, extra: { name: 'USDC', version: '2' },
  }],
};
console.log(`402 challenge  payTo=${challenge.accepts[0].payTo} (service claims ${HONEST_PAYEE})`);

// 3. bare car: signs whatever the 402 says
const req = challenge.accepts[0];
const payment = await signAuth(carPk, req.payTo as Address, BigInt(req.maxAmountRequired));
console.log(`car signed     TransferWithAuthorization → ${req.payTo}, ${Number(req.maxAmountRequired) / 1e6} USDC`);

// 4. facilitator settles
const drainTx = await settle(payment);
console.log(`SETTLED        ${tx(drainTx)}`);
await new Promise((r) => setTimeout(r, 4000)); // let the public RPC catch up before reading balances
console.log(`balances       car ${await usd(car)} USDC · attacker ${await usd(ATTACKER)} USDC`);
