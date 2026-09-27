// Public replay of the x402 payee-swap crash on Base Sepolia (x402's test network), with Circle's test USDC (real EIP-3009).
// The bare lane does this on the Base-mainnet fork; the replay puts the same payment where anyone can check it:
//   1. a fresh car wallet is funded with the invoice amount (a plain transfer from the funder)
//   2. the car signs a TransferWithAuthorization to the swapped payTo from the 402, with no checks (the bare lane)
//   3. the funder, acting as facilitator, settles it on-chain → USDC moves car → attacker
import { createPublicClient, createWalletClient, http, parseSignature, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const BASE_SEPOLIA_USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // EIP-712 domain "USDC" / "2"
export const baseSepoliaTxUrl = (h: Hex) => `https://sepolia.basescan.org/tx/${h}`;

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

export interface PublicSwapReplay {
  car: Address;
  fundTx: Hex;
  settleTx: Hex;
}

export async function replayX402SwapOnBaseSepolia(opts: {
  funderPk: Hex;
  payTo: Address;
  amountUnits: bigint;
  rpcUrl?: string;
  log?: (line: string) => void;
}): Promise<PublicSwapReplay> {
  const log = opts.log ?? (() => {});
  const transport = http(opts.rpcUrl ?? 'https://sepolia.base.org');
  const pc = createPublicClient({ chain: baseSepolia, transport });
  const facilitator = createWalletClient({ account: privateKeyToAccount(opts.funderPk), chain: baseSepolia, transport });
  const balance = (a: Address) => pc.readContract({ address: BASE_SEPOLIA_USDC, abi: ABI, functionName: 'balanceOf', args: [a] });

  const carPk = generatePrivateKey();
  const car = privateKeyToAccount(carPk);

  const fundTx = await facilitator.writeContract({ address: BASE_SEPOLIA_USDC, abi: ABI, functionName: 'transfer', args: [car.address, opts.amountUnits] });
  if ((await pc.waitForTransactionReceipt({ hash: fundTx })).status !== 'success') throw new Error(`funding reverted: ${fundTx}`);
  for (let i = 0; i < 30 && (await balance(car.address)) < opts.amountUnits; i++) await new Promise((r) => setTimeout(r, 1500)); // public RPC nodes lag
  log(`funded ${car.address} ${baseSepoliaTxUrl(fundTx)}`);

  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const message = { from: car.address, to: opts.payTo, value: opts.amountUnits, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 600), nonce };
  const signature = await car.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: baseSepolia.id, verifyingContract: BASE_SEPOLIA_USDC },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message,
  });
  const { v, r, s } = parseSignature(signature);
  const settleTx = await facilitator.writeContract({
    address: BASE_SEPOLIA_USDC, abi: ABI, functionName: 'transferWithAuthorization',
    args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, Number(v ?? 27n), r, s],
  });
  if ((await pc.waitForTransactionReceipt({ hash: settleTx })).status !== 'success') throw new Error(`settlement reverted: ${settleTx}`);
  log(`settled ${car.address} → ${opts.payTo} ${baseSepoliaTxUrl(settleTx)}`);
  return { car: car.address, fundTx, settleTx };
}
