import type { PublicTrade, Trade } from "../types/trades.js";

export interface WireTrade {
  tid: string;
  aid: string;
  anm: string;
  p: string;
  pc: string;
  pn: string;
  q: string;
  qc: string;
  qn: string;
  ve: string;
  pdt: number;
  vp: string;
  tdt: number;
  oid: string;
  s: "buy" | "sell";
  im: boolean;
}

export interface WirePublicTrade {
  tid: string;
  aid: string;
  anm: string;
  p: string;
  pc: string;
  pn: string;
  q: string;
  qc: string;
  qn: string;
  ve: string;
  pdt: number;
  vp: string;
  tdt: number;
}

function toUUID(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mapTrade(t: WireTrade): Trade {
  return {
    id: toUUID(t.tid),
    symbol: `${t.qc}/${t.pc}`,
    price: t.p,
    quantity: t.q,
    side: t.s,
    orderId: t.oid,
    maker: t.im,
    timestamp: t.tdt,
  };
}

export function mapPublicTrade(t: WirePublicTrade): PublicTrade {
  return {
    id: toUUID(t.tid),
    symbol: `${t.qc}/${t.pc}`,
    price: t.p,
    quantity: t.q,
    timestamp: t.tdt,
  };
}
