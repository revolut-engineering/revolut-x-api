import { Decimal } from "decimal.js";
import type { LivePriceSource, ScenarioCandle } from "../types.js";
import { degenerateCandle, tickTimestamp } from "../internal/candles.js";

export function inlineCandles(values: number[]): ScenarioCandle[] {
  const t0 = Date.now();
  return values.map((v, i) =>
    degenerateCandle(new Decimal(v), tickTimestamp(t0, i)),
  );
}

export function inlineLiveSource(values: number[]): LivePriceSource {
  let i = 0;
  const t0 = Date.now();
  return {
    async next() {
      if (i >= values.length) return null;
      const tick = {
        price: new Decimal(values[i]),
        timestamp: tickTimestamp(t0, i),
      };
      i++;
      return tick;
    },
  };
}
