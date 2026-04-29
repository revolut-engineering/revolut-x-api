export const mockBalance = {
  currency: "BTC",
  available: "1.5",
  reserved: "0.1",
  total: "1.6",
};

export const mockUsdBalance = {
  currency: "USD",
  available: "10000",
  reserved: "0",
  total: "10000",
};

export const mockCurrency = {
  symbol: "BTC",
  name: "Bitcoin",
  scale: 8,
  asset_type: "crypto",
  status: "active",
};

export const mockUsdCurrency = {
  symbol: "USD",
  name: "US Dollar",
  scale: 2,
  asset_type: "fiat",
  status: "active",
};

export const mockCurrencyPair = {
  base: "BTC",
  quote: "USD",
  base_step: "0.0000001",
  quote_step: "0.01",
  min_order_size: "0.0000001",
  max_order_size: "1000",
  min_order_size_quote: "0.01",
  status: "active",
};

export const mockTicker = {
  symbol: "BTC/USD",
  bid: "95000",
  ask: "95100",
  mid: "95050",
  last_price: "95050",
};

export const mockOrder = {
  id: "ord-123",
  client_order_id: "client-123",
  symbol: "BTC/USD",
  side: "buy",
  type: "limit",
  quantity: "0.1",
  filled_quantity: "0",
  leaves_quantity: "0.1",
  price: "95000",
  status: "new",
  time_in_force: "gtc",
  execution_instructions: ["allow_taker"],
  created_date: 1700000000000,
  updated_date: 1700000000000,
};
