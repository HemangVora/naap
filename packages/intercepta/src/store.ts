// Persistent JSON cache + request-budget counter for the Intercepta client.
// One file (data/intercepta-cache.json by default) holds raw responses keyed by address and the budget.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_CACHE_PATH = join(REPO_ROOT, 'data', 'intercepta-cache.json');
export const DEFAULT_PROBE_PATH = join(REPO_ROOT, 'data', 'intercepta-probe.json');

export interface CacheEntry<T = unknown> {
  at: number; // ms epoch of the live response
  raw: T; // the response body exactly as returned
  endpoint: string; // path that was called, for the README/judges
}

export interface StoreFile {
  version: 1;
  budget: { used: number; ceiling: number; firstAt?: number; lastAt?: number };
  quickScan: Record<string, CacheEntry>; // key: lowercase address
  scanToken: Record<string, CacheEntry>; // key: `${chainId}:${lowercase address}`
}

function empty(ceiling: number): StoreFile {
  return { version: 1, budget: { used: 0, ceiling }, quickScan: {}, scanToken: {} };
}

export class Store {
  data: StoreFile;
  constructor(
    public readonly path: string | null,
    ceiling: number,
  ) {
    this.data = empty(ceiling);
    if (path && existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreFile>;
        if (parsed && parsed.version === 1) {
          this.data = {
            version: 1,
            budget: { used: Number(parsed.budget?.used ?? 0), ceiling, firstAt: parsed.budget?.firstAt, lastAt: parsed.budget?.lastAt },
            quickScan: parsed.quickScan ?? {},
            scanToken: parsed.scanToken ?? {},
          };
        }
      } catch {
        // Corrupt file: start clean but keep it on disk until the next successful write overwrites it.
      }
    }
    this.data.budget.ceiling = ceiling;
  }

  static quickKey(address: string) {
    return address.toLowerCase();
  }
  static tokenKey(address: string, chainId: number) {
    return `${chainId}:${address.toLowerCase()}`;
  }

  getQuick(address: string) {
    return this.data.quickScan[Store.quickKey(address)];
  }
  getToken(address: string, chainId: number) {
    return this.data.scanToken[Store.tokenKey(address, chainId)];
  }
  putQuick(address: string, entry: CacheEntry) {
    this.data.quickScan[Store.quickKey(address)] = entry;
    this.flush();
  }
  putToken(address: string, chainId: number, entry: CacheEntry) {
    this.data.scanToken[Store.tokenKey(address, chainId)] = entry;
    this.flush();
  }

  /** Every request we actually send counts, including failures and timeouts (conservative: the API may bill them). */
  spend(now = Date.now()) {
    const b = this.data.budget;
    b.used += 1;
    b.firstAt ??= now;
    b.lastAt = now;
    this.flush();
  }
  get remaining() {
    return Math.max(0, this.data.budget.ceiling - this.data.budget.used);
  }
  get exhausted() {
    return this.data.budget.used >= this.data.budget.ceiling;
  }

  flush() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
      renameSync(tmp, this.path);
    } catch {
      // Disk trouble must never break a payment decision; the in-memory copy is still authoritative.
    }
  }
}

/** Read the persisted budget without constructing a screener (used by `budget()` and the probe). */
export function readBudgetFile(path = DEFAULT_CACHE_PATH, ceiling = 900) {
  const s = new Store(path, ceiling);
  return { ...s.data.budget, remaining: s.remaining };
}
