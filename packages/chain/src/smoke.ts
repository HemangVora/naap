// `pnpm --filter @crumple/chain smoke` — start fork, fund a car to $500, sign an EIP-3009 authorization with a
// local key, settle it as the facilitator, show balances + loss detection, stop the fork. Never prints BASE_RPC_URL.
import { createWalletClient, encodeFunctionData, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CAR_START_BALANCE_USD } from '@crumple/core';
import { createChain } from './chain.js';
import { signAuthorization } from './eip3009.js';
import { startFork } from './fork.js';
import { USDC_DOMAIN, usdToUnits } from './usdc.js';
import { createXPayment, paymentRequiredBody, paymentRequirements, verifyPayment } from './x402.js';
import { DRB } from './drb.js';
import { ERC20_ABI } from './usdc.js';

// NOT an anvil default key: those addresses carry EIP-7702 delegations on Base mainnet (fundCar clears code anyway)
const car = privateKeyToAccount(keccak256(toHex('crumple:chain:smoke-car')));
const weather = '0x1111111111111111111111111111111111111111' as const;
const attacker = '0xbad0000000000000000000000000000000000bad' as const;

async function main() {
  if (!process.env.BASE_RPC_URL) throw new Error('BASE_RPC_URL missing — run with `node --env-file=.env` or export it');
  const t0 = Date.now();
  const fork = await startFork({ port: 0, verbose: process.env.ANVIL_VERBOSE === '1' });
  try {
    const chain = createChain({ rpcUrl: fork.rpcUrl });
    console.log(`[smoke] fork ready in ${Date.now() - t0} ms · block ${fork.forkBlock} · facilitator ${chain.facilitator}`);
    console.log(`[smoke] USDC domain on fork:`, await chain.verifyUsdcDomain());

    await chain.fundCar(car.address, CAR_START_BALANCE_USD);
    console.log(`[smoke] car ${car.address} funded → $${await chain.balanceUsd(car.address)} USDC`);

    // 1) legit x402: 402 body → buyer signs → seller verifies → facilitator settles
    const req = paymentRequirements({ payTo: weather, priceUsd: 1, resource: 'https://weather.naap.eth/report', description: "Today's Tokyo weather report" });
    console.log('[smoke] 402 body:', JSON.stringify(paymentRequiredBody(req)));
    const header = await createXPayment(car, req);
    const v = await verifyPayment(header, req);
    if (!v.valid) throw new Error(`verifyPayment failed: ${v.reason}`);
    const legit = await chain.settle(v.auth);
    const legitLoss = await chain.lossFromReceipt(legit.txHash, [weather], car.address);
    console.log(`[smoke] legit settled ${legit.txHash} · paid $${legitLoss.paidUsd} · loss $${legitLoss.lossUsd} · balance $${await chain.balanceUsd(car.address)}`);

    // 2) the crash: a bare wallet signs $450 to the attacker; the fork records the loss
    const bad = await signAuthorization(car, { to: attacker, value: usdToUnits(450) });
    const crash = await chain.settle(bad);
    const crashLoss = await chain.lossFromReceipt(crash.txHash, [weather], car.address);
    console.log(`[smoke] attacker settled ${crash.txHash} · loss $${crashLoss.lossUsd} (to ${crashLoss.transfers[0]?.to}) · balance $${await chain.balanceUsd(car.address)}`);

    // 3) replay refused on-chain
    try {
      await chain.settle(bad);
      console.log('[smoke] !! replay was accepted — this must not happen');
      process.exitCode = 1;
    } catch (e) {
      console.log(`[smoke] replay refused: ${(e as Error).message.split('\n')[0].slice(0, 120)}`);
    }

    // 4) re-fund resets to EXACT $500 for the next barrier
    await chain.fundCar(car.address, CAR_START_BALANCE_USD);
    console.log(`[smoke] re-funded → $${await chain.balanceUsd(car.address)}`);

    // 5) DRB: funded by fundCar; the car pays with a signed plain ERC-20 transfer sent through sendRaw
    if (DRB.enabled) {
      console.log(`[smoke] DRB ${DRB.address} balance → ${(await chain.drbBalance(car.address)) / 10n ** 18n} DRB`);
      const wallet = createWalletClient({ account: car, chain: chain.publicClient.chain, transport: http(fork.rpcUrl) });
      const signed = await wallet.signTransaction(
        await wallet.prepareTransactionRequest({ to: DRB.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [attacker, 250n * 10n ** 18n] }) }),
      );
      const { txHash } = await chain.sendRaw(signed);
      const drbLoss = await chain.lossFromReceipt(txHash, [weather], car.address);
      console.log(`[smoke] DRB sendRaw ${txHash} · transfers ${drbLoss.transfers.map((t) => `${t.value / 10n ** 18n} DRB → ${t.to}`).join(', ')} · balance ${(await chain.drbBalance(car.address)) / 10n ** 18n} DRB`);
    } else {
      console.log('[smoke] DRB disabled (DRB_DISABLED=1) — grok-morse uses USDC');
    }

    const ok = legitLoss.paidUsd === 1 && legitLoss.lossUsd === 0 && crashLoss.lossUsd === 450;
    console.log(ok ? `[smoke] OK in ${Date.now() - t0} ms · domain ${USDC_DOMAIN.name} v${USDC_DOMAIN.version}` : '[smoke] FAILED');
    if (!ok) process.exitCode = 1;
  } finally {
    await fork.stop();
  }
}

main().catch((e) => {
  console.error('[smoke] error:', (e as Error).message);
  process.exit(1);
});
