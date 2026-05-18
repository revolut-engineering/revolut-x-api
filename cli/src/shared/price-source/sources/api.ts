import { Decimal } from "decimal.js";
import type {
  RevolutXClient,
  Candle as ApiCandle,
} from "@revolut/revolut-x-api";
import type { ScenarioCandle, LivePriceSource, PriceTick } from "../types.js";

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

export interface OrderBookMidProviderOptions {
  client: RevolutXClient;
  pair: string;
  intervalSec: number;
}

export class OrderBookMidProvider implements LivePriceSource {
  readonly paceIntervalSec: number;
  private _client: RevolutXClient;
  private _pair: string;

  constructor(opts: OrderBookMidProviderOptions) {
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
    const resp = await this._client.getOrderBook(this._pair, { limit: 1 });
    const bestBid = resp.data.bids[0];
    const bestAsk = resp.data.asks[0];
    if (!bestBid || !bestAsk) {
      throw new Error(`No order book data for ${this._pair}`);
    }
    return new Decimal(bestBid.price).plus(new Decimal(bestAsk.price)).div(2);
  }
}
