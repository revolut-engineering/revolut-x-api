import type { OrderBookLevel } from "../types/market.js";

export interface WireOrderBookLevel {
  aid: string;
  anm: string;
  s: "SELL" | "BUYI";
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

export function mapOrderBookLevel(l: WireOrderBookLevel): OrderBookLevel {
  return {
    price: l.p,
    quantity: l.q,
    orderCount: Number(l.no),
  };
}
