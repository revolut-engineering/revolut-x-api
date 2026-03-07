export interface Currency {
  symbol: string;
  name: string;
  scale: number;
  asset_type: "fiat" | "crypto";
  status: "active" | "inactive";
}

export interface CurrencyPair {
  base: string;
  quote: string;
  base_step: string;
  quote_step: string;
  min_order_size: string;
  max_order_size: string;
  min_order_size_quote: string;
  status: "active" | "inactive";
}

/** Map of currency code → Currency */
export type CurrencyMap = Record<string, Currency>;

/** Map of pair code (slash format, e.g. "BTC/USD") → CurrencyPair */
export type CurrencyPairMap = Record<string, CurrencyPair>;
