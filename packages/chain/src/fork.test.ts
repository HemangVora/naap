// Fork tests: need BASE_RPC_URL (load with `node --env-file=.env` / `pnpm vitest` after `set -a; . .env`) and anvil on PATH.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, encodeFunctionData, getAddress, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CAR_START_BALANCE_USD } from '@crumple/core';
import { createChain, type ChainWithHelpers } from './chain.js';
import { signAuthorization } from './eip3009.js';
import { startFork, type ForkHandle } from './fork.js';
import { ERC20_ABI, USDC_DOMAIN, usdToUnits } from './usdc.js';
import { DRB, DRB_START_UNITS } from './drb.js';
import { createXPayment, paymentRequirements, verifyPayment } from './x402.js';

const hasRpc = !!process.env.BASE_RPC_URL;
// NOT an anvil default key: those addresses carry EIP-7702 delegations on Base mainnet (fundCar clears code anyway)
const car = privateKeyToAccount(keccak256(toHex('crumple:chain:test-car')));
const weather = '0x1111111111111111111111111111111111111111' as const;
const attacker = '0xbad0000000000000000000000000000000000bad' as const;

describe.skipIf(!hasRpc)('anvil Base fork', () => {
  let fork: ForkHandle;
  let chain: ChainWithHelpers;
  let snap: `0x${string}`;

  beforeAll(async () => {
    fork = await startFork({ port: 0, log: () => undefined });
    chain = createChain({ rpcUrl: fork.rpcUrl, log: () => undefined });
    snap = await chain.snapshot();
  }, 120_000);
  afterAll(async () => {
    await fork?.stop();
  });

  it('pins the block and reports chain 8453', async () => {
    expect(fork.chainId).toBe(8453);
    expect(await chain.publicClient.getChainId()).toBe(8453);
    expect(Number(await chain.publicClient.getBlockNumber())).toBeGreaterThanOrEqual(fork.forkBlock);
  });

  it('USDC_DOMAIN matches the contract on the fork', async () => {
    expect(await chain.verifyUsdcDomain()).toEqual(USDC_DOMAIN);
  });

  it('fundCar sets an EXACT balance (idempotent, re-fund resets)', async () => {
    await chain.fundCar(car.address, CAR_START_BALANCE_USD);
    expect(await chain.balanceUsd(car.address)).toBe(500);
    expect(await chain.balanceUnits(car.address)).toBe(usdToUnits(500));
    await chain.fundCar(car.address, 12.34);
    expect(await chain.balanceUsd(car.address)).toBe(12.34);
    await chain.fundCar(car.address, CAR_START_BALANCE_USD);
    expect(await chain.publicClient.getBalance({ address: car.address })).toBeGreaterThan(0n);
  });

  it('settle() moves USDC via transferWithAuthorization and loss is read from the receipt', async () => {
    await chain.fundCar(car.address, 500);
    const auth = await signAuthorization(car, { to: attacker, value: usdToUnits(450) });
    const { txHash } = await chain.settle(auth);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await chain.balanceUsd(car.address)).toBe(50);
    expect(await chain.authorizationUsed(car.address, auth.nonce)).toBe(true);
    const loss = await chain.lossFromReceipt(txHash, [weather], car.address);
    expect(loss.lossUsd).toBe(450);
    expect(loss.paidUsd).toBe(0);
    expect(loss.transfers).toHaveLength(1);
    // replay is refused by the contract (nonce used)
    await expect(chain.settle(auth)).rejects.toThrow(/used|canceled|revert/i);
  });

  it('x402 flow: 402 → signed X-PAYMENT → verify → settle → paid, no loss', async () => {
    await chain.fundCar(car.address, 500);
    const req = paymentRequirements({ payTo: weather, priceUsd: 1, resource: 'https://weather.crumple.eth/report' });
    const header = await createXPayment(car, req);
    const v = await verifyPayment(header, req);
    expect(v.valid).toBe(true);
    if (!v.valid) return;
    const { txHash } = await chain.settle(v.auth);
    const loss = await chain.lossFromReceipt(txHash, [weather], car.address);
    expect(loss).toMatchObject({ lossUsd: 0, paidUsd: 1 });
    expect(await chain.balanceUsd(car.address)).toBe(499);
  });

  it('concurrent settles from one facilitator do not collide on nonces', async () => {
    await chain.fundCar(car.address, 500);
    const auths = await Promise.all([1, 2, 3, 4].map((i) => signAuthorization(car, { to: weather, value: usdToUnits(i) })));
    const results = await Promise.all(auths.map((a) => chain.settle(a)));
    expect(new Set(results.map((r) => r.txHash)).size).toBe(4);
    expect(await chain.balanceUsd(car.address)).toBe(490);
  });

  it('DRB: funded on fundCar, paid with a signed plain transfer via sendRaw, listed in the loss report', async () => {
    await chain.fundCar(car.address, 500);
    expect(await chain.drbBalance(car.address)).toBe(DRB_START_UNITS);
    const wallet = createWalletClient({ account: car, chain: chain.publicClient.chain, transport: http(fork.rpcUrl) });
    const signed = await wallet.signTransaction(
      await wallet.prepareTransactionRequest({
        to: DRB.address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [attacker, 10n ** 18n] }),
      }),
    );
    const { txHash } = await chain.sendRaw(signed);
    expect(await chain.drbBalance(car.address)).toBe(DRB_START_UNITS - 10n ** 18n);
    const loss = await chain.lossFromReceipt(txHash, [weather], car.address);
    expect(loss.lossUsd).toBe(0); // DRB is not priced in USD
    expect(loss.transfers).toEqual([{ token: DRB.address, from: car.address, to: getAddress(attacker), value: 10n ** 18n }]);
    await chain.fundCar(car.address, 500);
    expect(await chain.drbBalance(car.address)).toBe(DRB_START_UNITS);
  });

  it('snapshot/revert restores balances (tests only)', async () => {
    await chain.revert(snap);
    expect(await chain.balanceUsd(car.address)).toBe(0);
  });
});
