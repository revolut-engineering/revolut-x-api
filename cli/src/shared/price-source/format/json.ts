import { Decimal } from "decimal.js";
import type { ScenarioCandle } from "../types.js";
import { degenerateCandle, tickTimestamp } from "../internal/candles.js";
import { ParseError, pickDecimal } from "./common.js";

export function parseJson(raw: string, sourceLabel: string): ScenarioCandle[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ParseError(
      `${sourceLabel}: invalid JSON (${(err as Error).message})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ParseError(`${sourceLabel}: JSON must be an array`);
  }
  const t0 = Date.now();
  const out: ScenarioCandle[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item === "number") {
      out.push(degenerateCandle(new Decimal(item), tickTimestamp(t0, i)));
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if ("price" in obj && obj.price !== undefined) {
        const ts =
          typeof obj.timestamp === "number"
            ? obj.timestamp
            : tickTimestamp(t0, i);
        out.push(degenerateCandle(new Decimal(String(obj.price)), ts));
        continue;
      }
      const open = pickDecimal(obj, ["open", "o"]);
      const close = pickDecimal(obj, ["close", "c"]);
      if (open && close) {
        const high =
          pickDecimal(obj, ["high", "h"]) ?? Decimal.max(open, close);
        const low = pickDecimal(obj, ["low", "l"]) ?? Decimal.min(open, close);
        const volume = pickDecimal(obj, ["volume", "v"]);
        const ts =
          typeof obj.timestamp === "number"
            ? obj.timestamp
            : typeof obj.start === "number"
              ? obj.start
              : tickTimestamp(t0, i);
        out.push({ start: ts, open, high, low, close, volume });
        continue;
      }
    }
    throw new ParseError(
      `${sourceLabel}: item ${i} could not be interpreted as a price or candle`,
    );
  }
  if (out.length === 0) {
    throw new ParseError(`${sourceLabel}: JSON array is empty`);
  }
  return out;
}
