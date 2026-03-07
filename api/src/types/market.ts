export interface Ticker {
  symbol: string;
  bid: string;
  ask: string;
  mid: string;
  last_price: string;
}

export interface TickersOptions {
  symbols?: string[];
}

export interface Candle {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface CandlesOptions {
  interval?: number | string;
  since?: number;
  until?: number;
}

/** Authenticated order book price level (epoch ms timestamps) */
export interface OrderBookLevel {
  aid: string;
  anm: string;
  s: "SELL" | "BUYI"; // API returns "BUYI" (not "BUY") for buy-side levels
  p: string;
  pc: string;
  pn: string;
  q: string;
  qc: string;
  qn: string;
  ve: string;
  no: string;
  ts: string;
  pdt: number;
}

/** Public order book price level (ISO-8601 timestamps) */
export interface OrderBookPublicLevel {
  aid: string;
  anm: string;
  s: "SELL" | "BUYI"; // API returns "BUYI" (not "BUY") for buy-side levels
  p: string;
  pc: string;
  pn: string;
  q: string;
  qc: string;
  qn: string;
  ve: string;
  no: string;
  ts: string;
  pdt: string;
}

export interface OrderBook<T> {
  asks: T[];
  bids: T[];
}

export interface OrderBookOptions {
  limit?: number;
}

export interface TickerMetadata {
  timestamp: number;
}

export interface PublicMetadata {
  timestamp: string;
}
