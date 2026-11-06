export interface PublicTrade {
  id: string;
  symbol: string;
  price: string;
  quantity: string;
  timestamp: number;
}

export interface Trade {
  id: string;
  symbol: string;
  price: string;
  quantity: string;
  side: "buy" | "sell";
  orderId: string;
  maker: boolean;
  timestamp: number;
}

export interface TradesOptions {
  startDate?: number;
  endDate?: number;
  cursor?: string;
  limit?: number;
}

export interface TradingVolumeEntry {
  type: "spot" | "futures";
  amount: string;
  currency: string;
  start_date: number;
  end_date: number;
}

export interface TradingVolumeOptions {
  intervalDays?: number;
}

export interface TradingVolumeResponse {
  data: TradingVolumeEntry[];
  metadata: { timestamp: number };
}
