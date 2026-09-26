// The single relayer wallet: viem clients + the one nonce queue. Shared by the mandate source and the rating writer.
import { createPublicClient, createWalletClient, http, keccak256, type PublicClient, type WalletClient, type Transport, type Chain, type Account } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { Address, Hex } from '@crumple/core';
import { createNonceQueue, errorText, type NonceQueue, type TxRequest, type TxSender } from './nonceQueue.js';
import { ETHERSCAN } from './addresses.js';

export interface RelayerConfig {
  rpcUrl: string;
  /** Hex private key. Never logged. */
  privateKey: Hex;
  log?: (line: string) => void;
  /** Receipt wait timeout (ms), default 180_000. */
  receiptTimeoutMs?: number;
}

export interface Relayer {
  readonly address: Address;
  readonly account: Account;
  readonly publicClient: PublicClient<Transport, typeof sepolia>;
  readonly walletClient: WalletClient<Transport, typeof sepolia, Account>;
  readonly queue: NonceQueue;
  readonly log: (line: string) => void;
  /** Convenience: queue a contract call. */
  send(tx: TxRequest): Promise<{ hash: Hex; status: 'success' | 'reverted' }>;
}

export const explorerTx = (hash: Hex) => `${ETHERSCAN}/tx/${hash}`;
export const explorerAddr = (a: Address) => `${ETHERSCAN}/address/${a}`;

const cache = new Map<string, Relayer>();

/** One Relayer (and therefore one nonce queue) per (rpcUrl, key) per process. */
export function createRelayer(cfg: RelayerConfig): Relayer {
  const account = privateKeyToAccount(cfg.privateKey);
  const cacheKey = `${cfg.rpcUrl}|${account.address.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const log = cfg.log ?? ((l: string) => console.log(`[ens/relayer] ${l}`));
  const transport = http(cfg.rpcUrl, { timeout: 20_000, retryCount: 2 });
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ chain: sepolia, transport, account });

  const sender: TxSender = {
    getNonce: () => publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    estimateGas: (tx) => publicClient.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value }),
    async send(tx) {
      const fees = await publicClient.estimateFeesPerGas();
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      const base = block.baseFeePerGas ?? 0n;
      const prio = max(fees.maxPriorityFeePerGas ?? 0n, 1_500_000_000n); // ≥1.5 gwei tip so Sepolia actually includes us
      const maxFee = max(fees.maxFeePerGas ?? 0n, base * 2n + prio);
      const serialized = await walletClient.signTransaction({
        account,
        chain: sepolia,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gas: tx.gas,
        nonce: tx.nonce,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: prio,
        type: 'eip1559',
      });
      const hash = keccak256(serialized);
      try {
        await publicClient.sendRawTransaction({ serializedTransaction: serialized });
      } catch (e) {
        // The pool already has exactly this tx (e.g. a retried broadcast) — treat as sent.
        if (/already known|known transaction/i.test(errorText(e))) return hash;
        throw e;
      }
      return hash;
    },
    async wait(hash) {
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs ?? 180_000, pollingInterval: 3_000 });
      return { status: r.status, blockNumber: r.blockNumber };
    },
  };

  const queue = createNonceQueue(sender, { log });
  const relayer: Relayer = {
    address: account.address,
    account,
    publicClient,
    walletClient,
    queue,
    log,
    async send(tx) {
      const r = await queue.submit(tx);
      return { hash: r.hash, status: r.status };
    },
  };
  cache.set(cacheKey, relayer);
  return relayer;
}

export function newRelayerKey(): Hex {
  return generatePrivateKey();
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
