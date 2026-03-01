/**
 * In-memory candle cache with staleness detection for the worker.
 */

interface CacheEntry {
  candles: Record<string, unknown>[];
  fetchedAt: number;
}

export class CandleCache {
  private readonly maxAgeSec: number;
  private readonly store = new Map<string, CacheEntry>();

  constructor(maxAgeSec = 300) {
    this.maxAgeSec = maxAgeSec;
  }

  get(pair: string): Record<string, unknown>[] | undefined {
    const entry = this.store.get(pair);
    return entry?.candles;
  }

  put(pair: string, candles: Record<string, unknown>[]): void {
    this.store.set(pair, {
      candles,
      fetchedAt: performance.now() / 1000,
    });
  }

  needsRefresh(pair: string): boolean {
    const entry = this.store.get(pair);
    if (!entry) return true;
    return performance.now() / 1000 - entry.fetchedAt > this.maxAgeSec;
  }

  pairsNeedingRefresh(pairs: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const p of pairs) {
      if (this.needsRefresh(p)) result.add(p);
    }
    return result;
  }
}
