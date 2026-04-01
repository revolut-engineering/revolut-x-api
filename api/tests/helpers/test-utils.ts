import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { RevolutXClient } from "../../src/client.js";

export const BASE_URL = "https://revx.revolut.com";

interface TestClientOptions {
  maxRetries?: number;
  timeout?: number;
  authenticated?: boolean;
  isAgent?: boolean;
}

export function createTestClient(
  options: TestClientOptions = {},
): RevolutXClient {
  const {
    authenticated = true,
    maxRetries = 0,
    timeout = 30_000,
    isAgent,
  } = options;

  if (!authenticated) {
    return new RevolutXClient({
      baseUrl: BASE_URL,
      maxRetries,
      timeout,
      autoLoadCredentials: false,
      isAgent,
    });
  }

  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  return new RevolutXClient({
    apiKey: "test-api-key",
    privateKey: createPrivateKey(privateKey),
    baseUrl: BASE_URL,
    maxRetries,
    timeout,
    autoLoadCredentials: false,
    isAgent,
  });
}

export const mockBalance = {
  currency: "BTC",
  available: "1.5",
  reserved: "0.1",
  total: "1.6",
};

export const mockCurrency = {
  symbol: "BTC",
  name: "Bitcoin",
  scale: 8,
  asset_type: "crypto",
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

export const mockCandle = {
  start: 1700000000000,
  open: "92000",
  high: "93000",
  low: "91000",
  close: "92500",
  volume: "1.5",
};

export const mockOrder = {
  id: "order-123",
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

export const mockOrderBookLevel = {
  aid: "BTC",
  anm: "Bitcoin",
  s: "SELL" as const,
  p: "95100",
  pc: "USD",
  pn: "MONE",
  q: "1",
  qc: "BTC",
  qn: "UNIT",
  ve: "REVX",
  no: "2",
  ts: "CLOB",
  pdt: 1700000000000,
};

export const mockTrade = {
  tid: "12345678123412341234123456789abc",
  aid: "BTC",
  anm: "Bitcoin",
  p: "95000",
  pc: "USD",
  pn: "MONE",
  q: "0.001",
  qc: "BTC",
  qn: "UNIT",
  ve: "REVX",
  pdt: 1700000000000,
  vp: "REVX",
  tdt: 1700000000000,
  oid: "d0184248-2de5-4b2a-9fe2-0cf42670da47",
  s: "buy" as const,
  im: false,
};
