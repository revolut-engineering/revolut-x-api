import { Decimal } from "decimal.js";
import type { ScenarioCandle } from "../types.js";
import { degenerateCandle, tickTimestamp } from "../internal/candles.js";
import { ParseError } from "./common.js";

export function parseCsv(raw: string, sourceLabel: string): ScenarioCandle[] {
  const lines = raw.split(/\r?\n/);
  const rows: string[][] = [];
  let headerSeen: string[] | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = splitCsvLine(trimmed);
    if (rows.length === 0 && cols.every((c) => !looksNumeric(c))) {
      headerSeen = cols.map((c) => c.toLowerCase());
      continue;
    }
    rows.push(cols);
  }
  if (rows.length === 0) {
    throw new ParseError(`${sourceLabel}: no data rows`);
  }
  const t0 = Date.now();
  const out: ScenarioCandle[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cols = rows[i];
    if (headerSeen) {
      out.push(parseHeaderedRow(headerSeen, cols, sourceLabel, t0, i));
      continue;
    }
    if (cols.length === 1) {
      const n = cols[0];
      if (!looksNumeric(n)) {
        throw new ParseError(
          `${sourceLabel}: row ${i + 1} not a number: '${n}'`,
        );
      }
      out.push(degenerateCandle(new Decimal(n), tickTimestamp(t0, i)));
      continue;
    }
    const candle = parseCsvCols(cols);
    if (!candle) {
      throw new ParseError(
        `${sourceLabel}: row ${i + 1} has ${cols.length} columns (expected 1, 4, 5, or 6)`,
      );
    }
    if (candle.start === 0) candle.start = tickTimestamp(t0, i);
    out.push(candle);
  }
  return out;
}

function parseHeaderedRow(
  header: string[],
  cols: string[],
  sourceLabel: string,
  t0: number,
  i: number,
): ScenarioCandle {
  const obj: Record<string, string> = {};
  for (let c = 0; c < header.length && c < cols.length; c++) {
    obj[header[c]] = cols[c];
  }
  const price = obj["price"];
  if (price !== undefined && obj["open"] === undefined) {
    const ts = obj["timestamp"]
      ? Number(obj["timestamp"])
      : tickTimestamp(t0, i);
    return degenerateCandle(new Decimal(price), ts);
  }
  const open = obj["open"];
  const close = obj["close"];
  if (open !== undefined && close !== undefined) {
    const o = new Decimal(open);
    const c = new Decimal(close);
    const high =
      obj["high"] !== undefined ? new Decimal(obj["high"]) : Decimal.max(o, c);
    const low =
      obj["low"] !== undefined ? new Decimal(obj["low"]) : Decimal.min(o, c);
    const volume =
      obj["volume"] !== undefined ? new Decimal(obj["volume"]) : undefined;
    const ts = obj["timestamp"]
      ? Number(obj["timestamp"])
      : tickTimestamp(t0, i);
    return { start: ts, open: o, high, low, close: c, volume };
  }
  throw new ParseError(
    `${sourceLabel}: header row missing required columns (need price or open+close)`,
  );
}

export function parseCsvCols(cols: string[]): ScenarioCandle | null {
  if (cols.length === 4) {
    const [o, h, l, c] = cols.map((v) => new Decimal(v));
    return { start: 0, open: o, high: h, low: l, close: c };
  }
  if (cols.length === 5) {
    const ts = Number(cols[0]);
    if (Number.isFinite(ts) && ts > 1e9) {
      const [o, h, l, c] = cols.slice(1).map((v) => new Decimal(v));
      return { start: ts, open: o, high: h, low: l, close: c };
    }
    const [o, h, l, c, v] = cols.map((x) => new Decimal(x));
    return { start: 0, open: o, high: h, low: l, close: c, volume: v };
  }
  if (cols.length === 6) {
    const ts = Number(cols[0]);
    const [o, h, l, c, v] = cols.slice(1).map((x) => new Decimal(x));
    return {
      start: Number.isFinite(ts) ? ts : 0,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
    };
  }
  return null;
}

export function splitCsvLine(line: string): string[] {
  const parts = line.split(",").map((s) => s.trim());
  while (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

export function looksNumeric(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return !Number.isNaN(Number(t));
}
