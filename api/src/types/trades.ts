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
