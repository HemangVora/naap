// `Chain` port implementation on an anvil Base fork, via viem. We are our own x402 facilitator.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  hashDomain,
  http,
  numberToHex,
  parseEventLogs,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Chain, Eip3009Auth } from '@crumple/core';
import { authFields, splitSignature } from './eip3009.js';
import {
  BASE_CHAIN_ID,
  ERC20_ABI,
  EIP3009_TYPES,
  USDC_ABI,
  USDC_ADDRESS,
  USDC_DOMAIN,
  unitsToUsd,
  usdToUnits,
  usdcBalanceSlot,
} from './usdc.js';
import { DRB, DRB_START_UNITS, fundDrb } from './drb.js';

/** anvil's account #0 — fine as facilitator on a fork; override with FACILITATOR_PK. */
export const ANVIL_DEFAULT_PK: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export interface CreateChainOpts {
  rpcUrl: string;
  /** Private key of the account that submits transferWithAuthorization. Default process.env.FACILITATOR_PK, then anvil #0. */
  facilitatorPk?: Hex;
  /** Gas ETH given to every funded car and to the facilitator. Default 1 ETH. */
  gasEth?: number;
  /** DRB given to every car at fundCar (base units). Default DRB_START_UNITS (1,000 DRB); 0n disables. */
  drbUnitsPerCar?: bigint;
  log?: (line: string) => void;
}

export interface TokenTransfer {
  token: Address;
  from: Address;
  to: Address;
  /** base units */
  value: bigint;
}

export interface LossReport {
  /** USDC that left `wallet` (or anyone, if no wallet given) to an address outside `allowedPayees`. */
  lossUsd: number;
  /** USDC that went to allowed payees. */
  paidUsd: number;
  transfers: TokenTransfer[];
}

export interface ChainWithHelpers extends Chain {
  publicClient: PublicClient<Transport, ViemChain>;
  facilitator: Address;
  /** Balance in base units. */
  balanceUnits(wallet: Address): Promise<bigint>;
  /** Reads Transfer logs from a settlement receipt and measures what left the wallet to non-mandate addresses. */
  lossFromReceipt(txHash: Hex, allowedPayees: Address[], wallet?: Address): Promise<LossReport>;
  /** Same, summed over several receipts. */
  lossFromReceipts(txHashes: Hex[], allowedPayees: Address[], wallet?: Address): Promise<LossReport>;
  /** Reads name/version/DOMAIN_SEPARATOR from the fork and checks them against USDC_DOMAIN. Throws on mismatch. */
  verifyUsdcDomain(): Promise<typeof USDC_DOMAIN>;
  /** true once the nonce has been used (authorizationState). */
  authorizationUsed(from: Address, nonce: Hex): Promise<boolean>;
  /** DRB balance in base units (0n when DRB is disabled). */
  drbBalance(wallet: Address): Promise<bigint>;
}

const ETH = 10n ** 18n;

/** One-line reason from a viem error: the contract's revert string when there is one. */
export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.reason) return r.reason;
    return e.shortMessage;
  }
  return (e as Error)?.message ?? String(e);
}

export function createChain(opts: CreateChainOpts): ChainWithHelpers {
  // DRB funding impersonates one holder; concurrent lanes would race its nonce ("replacement transaction underpriced").
  let drbTail: Promise<unknown> = Promise.resolve();
  const serialDrb = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = drbTail.then(fn, fn);
    drbTail = next.catch(() => undefined);
    return next;
  };
  const log = opts.log ?? ((l: string) => console.log(l));
  const pk = (opts.facilitatorPk ?? (process.env.FACILITATOR_PK as Hex | undefined) ?? ANVIL_DEFAULT_PK) as Hex;
  const account = privateKeyToAccount(pk);
  const transport = http(opts.rpcUrl, { batch: false, retryCount: 3 });
  // plain chain definition (no OP-stack formatters): what the fork is, nothing more
  const chain = defineChain({
    id: BASE_CHAIN_ID,
    name: 'Base (anvil fork)',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const publicClient: PublicClient<Transport, ViemChain> = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const gasWei = BigInt(Math.round((opts.gasEth ?? 1) * 1e6)) * (ETH / 10n ** 6n);
  const drbUnits = opts.drbUnitsPerCar ?? DRB_START_UNITS;

  const anvil = (method: string, params: unknown[]) => publicClient.request({ method: method as never, params: params as never }) as Promise<unknown>;

  let facilitatorFunded: Promise<void> | null = null;
  const ensureFacilitatorGas = () => (facilitatorFunded ??= anvil('anvil_setBalance', [account.address, numberToHex(gasWei)]).then(() => undefined));

  // One facilitator account, many concurrent runs: serialise sends so nonces never collide (anvil mines instantly).
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const balanceUnits = (wallet: Address) => publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [wallet] });

  /** A car wallet must be a plain EOA. Well-known addresses (e.g. anvil's defaults) carry EIP-7702 delegations on
   *  Base mainnet, which makes FiatToken verify via ERC-1271 instead of ecrecover → "invalid signature". */
  async function ensureEoa(wallet: Address) {
    const code = await publicClient.getCode({ address: wallet });
    if (code && code !== '0x') {
      log(`[chain] ${wallet} has code on the fork (${code.slice(0, 12)}…) — clearing so EIP-3009 uses ecrecover`);
      await anvil('anvil_setCode', [wallet, '0x']);
    }
  }

  async function setUsdcBalance(wallet: Address, units: bigint) {
    if (units >= 1n << 255n) throw new Error('setUsdcBalance: value would set the blacklist bit');
    await anvil('anvil_setStorageAt', [USDC_ADDRESS, usdcBalanceSlot(wallet), numberToHex(units, { size: 32 })]);
    const got = await balanceUnits(wallet);
    if (got !== units) throw new Error(`fundCar: balance slot mismatch — set ${units} but balanceOf=${got} (storage layout changed?)`);
  }

  async function lossFromReceipt(txHash: Hex, allowedPayees: Address[], wallet?: Address): Promise<LossReport> {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const allowed = new Set(allowedPayees.map((a) => a.toLowerCase()));
    const report: LossReport = { lossUsd: 0, paidUsd: 0, transfers: [] };
    if (receipt.status !== 'success') return report;
    const logs = parseEventLogs({ abi: ERC20_ABI, eventName: 'Transfer', logs: receipt.logs });
    for (const l of logs) {
      const t: TokenTransfer = { token: getAddress(l.address), from: getAddress(l.args.from), to: getAddress(l.args.to), value: l.args.value };
      report.transfers.push(t);
      if (t.token.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue; // DRB & others: listed, not priced
      if (wallet && t.from.toLowerCase() !== wallet.toLowerCase()) continue;
      if (allowed.has(t.to.toLowerCase())) report.paidUsd += unitsToUsd(t.value);
      else report.lossUsd += unitsToUsd(t.value);
    }
    return report;
  }

  const api: ChainWithHelpers = {
    chainId: BASE_CHAIN_ID,
    usdc: USDC_ADDRESS,
    drb: DRB.address,
    publicClient,
    facilitator: account.address,
    balanceUnits,
    lossFromReceipt,

    async lossFromReceipts(txHashes, allowedPayees, wallet) {
      const total: LossReport = { lossUsd: 0, paidUsd: 0, transfers: [] };
      for (const h of txHashes) {
        const r = await lossFromReceipt(h, allowedPayees, wallet);
        total.lossUsd += r.lossUsd;
        total.paidUsd += r.paidUsd;
        total.transfers.push(...r.transfers);
      }
      return total;
    },

    async snapshot() {
      return (await anvil('evm_snapshot', [])) as Hex;
    },
    async revert(id) {
      const ok = await anvil('evm_revert', [id]);
      if (!ok) throw new Error(`evm_revert(${id}) returned false`);
    },

    async fundCar(wallet, usd) {
      await Promise.all([
        ensureEoa(wallet),
        setUsdcBalance(wallet, usdToUnits(usd)),
        anvil('anvil_setBalance', [wallet, numberToHex(gasWei)]),
        drbUnits > 0n && DRB.enabled ? serialDrb(() => fundDrb(publicClient, wallet, drbUnits)).catch((e) => log(`[chain] DRB funding skipped: ${(e as Error).message}`)) : undefined,
      ]);
    },

    async balanceUsd(wallet) {
      return unitsToUsd(await balanceUnits(wallet));
    },

    async settle(auth: Eip3009Auth) {
      if (auth.token.toLowerCase() !== USDC_ADDRESS.toLowerCase()) throw new Error(`settle: only USDC supports EIP-3009 here (got ${auth.token})`);
      const f = authFields(auth);
      const { v, r, s } = splitSignature(auth.signature);
      await ensureFacilitatorGas();
      return serial(async () => {
        // simulate first: a revert here surfaces the FiatToken reason ("invalid signature", "authorization is used or canceled", …)
        let hash: Hex;
        try {
          const { request } = await publicClient.simulateContract({
            account,
            address: USDC_ADDRESS,
            abi: USDC_ABI,
            functionName: 'transferWithAuthorization',
            args: [f.from, f.to, f.value, f.validAfter, f.validBefore, f.nonce, v, r, s],
          });
          hash = await walletClient.writeContract(request);
        } catch (e) {
          throw new Error(`settle: ${revertReason(e)}`, { cause: e });
        }
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
        if (receipt.status !== 'success') throw new Error(`settle: tx ${hash} reverted`);
        return { txHash: hash };
      });
    },

    async sendRaw(signedTx) {
      return serial(async () => {
        const hash = await publicClient.sendRawTransaction({ serializedTransaction: signedTx });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
        if (receipt.status !== 'success') throw new Error(`sendRaw: tx ${hash} reverted`);
        return { txHash: hash };
      });
    },

    async verifyUsdcDomain() {
      const [name, version, sep] = await Promise.all([
        publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'name' }),
        publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'version' }),
        publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'DOMAIN_SEPARATOR' }),
      ]);
      const expected = hashDomain({ domain: { ...USDC_DOMAIN, chainId: BigInt(USDC_DOMAIN.chainId) }, types: { EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ], ...EIP3009_TYPES } });
      if (name !== USDC_DOMAIN.name || version !== USDC_DOMAIN.version || sep.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`USDC_DOMAIN mismatch: on-chain name="${name}" version="${version}" separator=${sep}, expected ${JSON.stringify(USDC_DOMAIN)} → ${expected}`);
      }
      return USDC_DOMAIN;
    },

    async drbBalance(wallet) {
      if (!DRB.enabled) return 0n;
      return publicClient.readContract({ address: DRB.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] });
    },

    async authorizationUsed(from, nonce) {
      return publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'authorizationState', args: [from, nonce] });
    },
  };
  return api;
}
