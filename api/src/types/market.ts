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
  startDate?: number;
  endDate?: number;
}

export interface OrderBookLevel {
  price: string;
  quantity: string;
  orderCount: number;
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