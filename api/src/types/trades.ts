/** Trade from authenticated endpoints (epoch ms timestamps) */
export interface Trade {
  tdt: number;
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
  tid: string;
  im: string;
  s: string;
}

export interface PublicTrade {
  tdt: string;
  aid: string;
  anm: string;
  p: string;
  pc: string;
  pn: string;
  q: string;
  qc: string;
  qn: string;
  ve: string;
  pdt: string;
  vp: string;
  tid: string;
}

export interface TradesOptions {
  startDate?: number;
  endDate?: number;
  cursor?: string;
  limit?: number;
}
