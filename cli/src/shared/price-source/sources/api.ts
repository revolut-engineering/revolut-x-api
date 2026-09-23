import { Decimal } from "decimal.js";
import type {
  RevolutXClient,
  Candle as ApiCandle,
} from "@revolut/revolut-x-api";
import type { ScenarioCandle, LivePriceSource, PriceTick } from "../types.js";

const MAX_INDEX_PRICE_DRIFT = new Decimal("0.05");

export interface ApiBatchOptions {
  client: RevolutXClient;
  pair: string;
  interval: string;
  days: number;
}

export async function loadApiCandles(
  opts: ApiBatchOptions,
): Promise<ScenarioCandle[]> {
  const startDate = Date.now() - opts.days * 24 * 60 * 60 * 1000;
  const resp = await opts.client.getCandles(opts.pair, {
    interval: opts.interval,
    startDate,
  });
  return parseApiCandles(resp.data);
}

export function parseApiCandles(candles: ApiCandle[]): ScenarioCandle[] {
  const out: Array<{ ts: number; candle: ScenarioCandle }> = [];
  for (const c of candles) {
    try {
      out.push({
        ts: c.start,
        candle: {
          start: c.start,
          open: new Decimal(c.open),
          high: new Decimal(c.high),
          low: new Decimal(c.low),
          close: new Decimal(c.close),
          volume: new Decimal(c.volume),
        },
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.map((p) => p.candle);
}

export function resolveTickerPrice(t: {
  mid?: string | null;
  index_price?: string | null;
  last_price?: string | null;
}): Decimal | null {
  const mid = parseTickerPrice(t.mid);
  const fallback = mid ?? parseTickerPrice(t.last_price);
  if (!mid) return fallback;

  const indexPrice = parseTickerPrice(t.index_price);
  if (!indexPrice) return fallback;

  const drift = indexPrice.minus(mid).abs().div(mid);
  return drift.lte(MAX_INDEX_PRICE_DRIFT) ? indexPrice : fallback;
}

function parseTickerPrice(raw: string | null | undefined): Decimal | null {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const price = new Decimal(String(raw));
    return price.isFinite() && price.gt(0) ? price : null;
  } catch {
    return null;
  }
}

export interface TickerPriceProviderOptions {
  client: RevolutXClient;
  pair: string;
  intervalSec: number;
}

export class TickerPriceProvider implements LivePriceSource {
  readonly paceIntervalSec: number;
  private _client: RevolutXClient;
  private _pair: string;

  constructor(opts: TickerPriceProviderOptions) {
    this._client = opts.client;
    this._pair = opts.pair;
    this.paceIntervalSec = opts.intervalSec;
  }

  async next(): Promise<PriceTick | null> {
    return { price: await this._poll(), timestamp: Date.now() };
  }

  async peek(): Promise<Decimal> {
    return this._poll();
  }

  private async _poll(): Promise<Decimal> {
    const resp = await this._client.getTickers({ symbols: [this._pair] });
    const ticker = resp.data.find(
      (t) => t.symbol.replace("/", "-") === this._pair,
    );
    if (!ticker) {
      throw new Error(`No ticker data for ${this._pair}`);
    }
    const price = resolveTickerPrice(ticker);
    if (price == null || price.lte(0)) {
      throw new Error(
        `Invalid ticker price for ${this._pair}: index=${ticker.index_price} mid=${ticker.mid} last=${ticker.last_price}`,
      );
    }
    return price;
  }
}
