import { Decimal } from "decimal.js";
import type { PriceTick, ScenarioCandle } from "../types.js";
import { degenerateCandle, tickTimestamp } from "../internal/candles.js";
import { ParseError, pickDecimal, pickPrice } from "./common.js";
import { parseCsvCols, splitCsvLine } from "./csv.js";

export function parseNdjson(
  raw: string,
  sourceLabel: string,
): ScenarioCandle[] {
  const t0 = Date.now();
  const out: ScenarioCandle[] = [];
  const lines = raw.split(/\r?\n/);
  let idx = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line.startsWith("#")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new ParseError(
        `${sourceLabel}: line ${li + 1} invalid JSON (${(err as Error).message})`,
      );
    }
    if ("price" in obj && obj.price !== undefined) {
      const ts =
        typeof obj.timestamp === "number"
          ? obj.timestamp
          : tickTimestamp(t0, idx);
      out.push(degenerateCandle(new Decimal(String(obj.price)), ts));
    } else {
      const open = pickDecimal(obj, ["open", "o"]);
      const close = pickDecimal(obj, ["close", "c"]);
      if (!open || !close) {
        throw new ParseError(
          `${sourceLabel}: line ${li + 1} missing price/open/close`,
        );
      }
      const high = pickDecimal(obj, ["high", "h"]) ?? Decimal.max(open, close);
      const low = pickDecimal(obj, ["low", "l"]) ?? Decimal.min(open, close);
      const volume = pickDecimal(obj, ["volume", "v"]);
      const ts =
        typeof obj.timestamp === "number"
          ? obj.timestamp
          : typeof obj.start === "number"
            ? obj.start
            : tickTimestamp(t0, idx);
      out.push({ start: ts, open, high, low, close, volume });
    }
    idx++;
  }
  if (out.length === 0) {
    throw new ParseError(`${sourceLabel}: no NDJSON rows parsed`);
  }
  return out;
}

export function parseLineToTick(line: string, index: number): PriceTick | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const t0 = Date.now();
  if (t.startsWith("{")) {
    const obj = JSON.parse(t);
    const price = pickPrice(obj);
    const ts =
      typeof obj.timestamp === "number"
        ? obj.timestamp
        : tickTimestamp(t0, index);
    return { price, timestamp: ts };
  }
  const cols = splitCsvLine(t);
  if (cols.length === 1) {
    const n = Number(cols[0]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { price: new Decimal(cols[0]), timestamp: tickTimestamp(t0, index) };
  }
  const candle = parseCsvCols(cols);
  if (!candle) return null;
  return { price: candle.close, timestamp: candle.start };
}
