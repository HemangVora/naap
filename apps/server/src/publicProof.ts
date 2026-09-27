// Live public proof for a bare-lane x402 swap crash: the same swapped payment is settled on Base Sepolia with real
// EIP-3009 test USDC (see @crumple/chain publicReplay.ts), and the car's report links the resulting tx.
// In-memory and best-effort: replays run one at a time (single funder nonce), and a failure only means no link.
import type { Address, Hex } from 'viem';
import { replayX402SwapOnBaseSepolia } from '@crumple/chain';

export type PublicProof = { status: 'pending' } | { status: 'done'; txHash: Hex; car: Address } | { status: 'error' };

export function createPublicProofs(opts: { funderPk?: Hex; payTo: Address; rpcUrl?: string; log: (line: string) => void }) {
  const proofs = new Map<string, PublicProof>();
  let chain: Promise<void> = Promise.resolve();
  return {
    get: (carId: string): PublicProof | null => proofs.get(carId) ?? null,
    start(carId: string, lossUsd: number) {
      if (!opts.funderPk || proofs.has(carId)) return;
      proofs.set(carId, { status: 'pending' });
      chain = chain.then(async () => {
        try {
          const r = await replayX402SwapOnBaseSepolia({
            funderPk: opts.funderPk!, payTo: opts.payTo, amountUnits: BigInt(Math.round(lossUsd * 1e6)), rpcUrl: opts.rpcUrl,
            log: (l) => opts.log(`[public-proof] ${carId} ${l}`),
          });
          proofs.set(carId, { status: 'done', txHash: r.settleTx, car: r.car });
        } catch (e) {
          opts.log(`[public-proof] ${carId} failed: ${(e as Error).message.slice(0, 160)}`);
          proofs.set(carId, { status: 'error' });
        }
      });
    },
  };
}
