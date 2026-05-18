import type { Decimal } from "decimal.js";
import type { ScenarioCandle } from "../types.js";

export const SYNTHETIC_TICK_INTERVAL_MS = 1000;

export function tickTimestamp(t0: number, index: number): number {
  return t0 + index * SYNTHETIC_TICK_INTERVAL_MS;
}

export function degenerateCandle(
  price: Decimal,
  timestamp: number,
): ScenarioCandle {
  return {
    start: timestamp,
    open: price,
    high: price,
    low: price,
    close: price,
  };
}
