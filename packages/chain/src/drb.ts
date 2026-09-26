// DRB — DebtReliefBot, the token Grok named and Bankr deployed via Clanker on Base (2025-03-07). Plain ERC-20,
// 18 decimals, no EIP-3009 → cars pay DRB with a signed `transfer` tx through `Chain.sendRaw`.
// Funding: impersonate the DRB/WETH Uniswap V3 pool (largest holder, ~3.96e27 units at the pinned block) on the fork.
// Override with DRB_ADDRESS / DRB_HOLDER; DRB_DISABLED=1 turns it off (grok-morse then uses USDC).
import { encodeFunctionData, numberToHex, type Address, type Chain, type PublicClient, type Transport } from 'viem';
import { ERC20_ABI } from './usdc.js';

const NONE: Address = '0x00000000000000000000000000000000000000d2'; // same placeholder as FakeChain.drb

function envAddr(k: string): Address | undefined {
  const v = process.env[k];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}

export const DRB_ADDRESS: Address = '0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2';
/** Uniswap V3 DRB/WETH 1% pool — impersonated as the faucet. */
export const DRB_POOL_HOLDER: Address = '0x5116773e18a9c7bb03ebb961b38678e45e238923';
export const DRB_DECIMALS = 18;
/** Every car starts each barrier with this much DRB (whole tokens). */
export const DRB_START_UNITS = 1_000n * 10n ** BigInt(DRB_DECIMALS);

export const DRB = {
  none: NONE,
  /** Token address, or the placeholder when disabled. */
  address: process.env.DRB_DISABLED === '1' ? NONE : (envAddr('DRB_ADDRESS') ?? DRB_ADDRESS),
  /** A holder with enough balance to fund cars (impersonated on the fork). */
  holder: envAddr('DRB_HOLDER') ?? DRB_POOL_HOLDER,
  get enabled() {
    return this.address !== NONE && !!this.holder;
  },
};

/** Sets `wallet`'s DRB balance to exactly `units` by moving tokens to/from the impersonated holder. */
export async function fundDrb(client: PublicClient<Transport, Chain>, wallet: Address, units: bigint): Promise<void> {
  if (!DRB.enabled || !DRB.holder) throw new Error('DRB not configured (DRB_ADDRESS + DRB_HOLDER)');
  const rpc = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never }) as Promise<unknown>;
  const current = await client.readContract({ address: DRB.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] });
  if (current === units) return;
  const from = current < units ? DRB.holder : wallet;
  const to = current < units ? wallet : DRB.holder;
  const delta = current < units ? units - current : current - units;
  await rpc('anvil_impersonateAccount', [from]);
  await rpc('anvil_setBalance', [from, numberToHex(10n ** 18n)]);
  try {
    const hash = (await rpc('eth_sendTransaction', [
      { from, to: DRB.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, delta] }) },
    ])) as `0x${string}`;
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== 'success') throw new Error(`DRB transfer reverted (${hash})`);
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [from]);
  }
}
