import type { LivePriceSource, PriceTick } from "./types.js";

export function withCachedPeek(source: LivePriceSource): LivePriceSource {
  if (source.peek) return source;
  let last: PriceTick | null = null;
  let buffered: PriceTick | null = null;
  return {
    paceIntervalSec: source.paceIntervalSec,
    async next() {
      if (buffered) {
        const t = buffered;
        buffered = null;
        last = t;
        return t;
      }
      const t = await source.next();
      if (t) last = t;
      return t;
    },
    async peek() {
      if (last) return last.price;
      const t = await source.next();
      if (!t) throw new Error("price source exhausted before any tick");
      buffered = t;
      last = t;
      return t.price;
    },
    async close() {
      await source.close?.();
    },
  };
}
