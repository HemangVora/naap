// RatingWriter on ENSv2 Sepolia: RATING_KEYS text records on <car>.naap.eth, through the ONE relayer queue.
// Never throws into callers; fires onConfirmed(carId, txHash) once mined.
import type { Hex, Rating, RatingWriter } from '@crumple/core';
import type { EnsMandateSource } from './ens.js';
import { errorText } from './nonceQueue.js';
import { carEnsName, encodeRatingRecords } from './records.js';

export interface EnsRatingWriter extends RatingWriter {
  readonly mode: 'ens';
  /** Writes queued or in flight. */
  readonly pending: number;
  /** Resolves when every queued write has settled (success, revert, or error). */
  idle(): Promise<void>;
  /** Last error per car, for the UI. */
  errors: Map<string, string>;
}

export function createEnsRatingWriter(source: EnsMandateSource, log = source.relayer.log): EnsRatingWriter {
  const cbs: ((carId: string, txHash: Hex) => void)[] = [];
  const errors = new Map<string, string>();
  let inflight: Promise<unknown>[] = [];

  async function write(carId: string, ensName: string, rating: Rating) {
    // If this car's mandate write is still queued, let it land first so the subname exists when the rating does.
    if (source.status(ensName) === 'pending') await source.whenConfirmed(ensName).catch(() => {});
    const r = await source.writeText(ensName, encodeRatingRecords(rating));
    if (r.status !== 'success') throw new Error(`rating tx reverted ${r.hash}`);
    errors.delete(carId);
    log(`rating on-chain ${ensName} ${r.hash}`);
    for (const cb of cbs) {
      try {
        cb(carId, r.hash);
      } catch (e) {
        log(`onConfirmed callback threw: ${errorText(e).slice(0, 120)}`);
      }
    }
  }

  return {
    mode: 'ens',
    errors,
    get pending() {
      return inflight.length;
    },
    enqueue(carId, ensName, rating) {
      try {
        const name = ensName || carEnsName(carId);
        const p = write(carId, name, rating).catch((e) => {
          errors.set(carId, errorText(e).slice(0, 300));
          log(`rating write FAILED for ${name}: ${errors.get(carId)}`);
        });
        inflight.push(p);
        p.finally(() => {
          inflight = inflight.filter((x) => x !== p);
        });
      } catch (e) {
        log(`rating enqueue threw: ${errorText(e).slice(0, 120)}`);
      }
    },
    onConfirmed(cb) {
      cbs.push(cb);
    },
    idle: () => Promise.allSettled(inflight).then(() => {}),
  };
}
