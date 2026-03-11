import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { RevolutXClient } from "../src/client.js";

const BASE = "https://revx.revolut.com";

function makeClient(overrides?: { maxRetries?: number }) {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return new RevolutXClient({
    apiKey: "test-key",
    privateKey: createPrivateKey(privateKey),
    baseUrl: BASE,
    maxRetries: overrides?.maxRetries ?? 0,
    autoLoadCredentials: false,
  });
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("getBalances", () => {
  it("returns array of balances", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/balances")
      .reply(200, [
        { currency: "BTC", available: "1.0", reserved: "0.1", total: "1.1" },
        { currency: "USD", available: "5000", reserved: "0", total: "5000" },
      ]);
    const result = await client.getBalances();
    expect(result).toHaveLength(2);
    expect(result[0].currency).toBe("BTC");
  });
});

describe("getCurrencies", () => {
  it("returns currency map", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/configuration/currencies")
      .reply(200, {
        BTC: {
          symbol: "BTC",
          name: "Bitcoin",
          scale: 8,
          asset_type: "crypto",
          status: "active",
        },
      });
    const result = await client.getCurrencies();
    expect(result.BTC.name).toBe("Bitcoin");
  });
});

describe("getCurrencyPairs", () => {
  it("returns pair map", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/configuration/pairs")
      .reply(200, {
        "BTC/USD": {
          base: "BTC",
          quote: "USD",
          base_step: "0.0000001",
          quote_step: "0.01",
          min_order_size: "0.0000001",
          max_order_size: "1000",
          min_order_size_quote: "0.01",
          status: "active",
        },
      });
    const result = await client.getCurrencyPairs();
    expect(result["BTC/USD"].base).toBe("BTC");
  });
});

describe("getTickers", () => {
  it("returns tickers with metadata", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/tickers")
      .reply(200, {
        data: [
          {
            symbol: "BTC/USD",
            bid: "95000",
            ask: "95100",
            mid: "95050",
            last_price: "95050",
          },
        ],
        metadata: { timestamp: 1700000000000 },
      });
    const result = await client.getTickers();
    expect(result.data[0].symbol).toBe("BTC/USD");
  });

  it("passes symbols filter", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/tickers")
      .query({ symbols: "BTC-USD" })
      .reply(200, {
        data: [
          {
            symbol: "BTC/USD",
            bid: "95000",
            ask: "95100",
            mid: "95050",
            last_price: "95050",
          },
        ],
        metadata: { timestamp: 1700000000000 },
      });
    const result = await client.getTickers({ symbols: ["BTC-USD"] });
    expect(result.data).toHaveLength(1);
  });
});

describe("getCandles", () => {
  it("returns candle data", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/candles/BTC-USD")
      .query({ interval: "60" })
      .reply(200, {
        data: [
          {
            start: 1700000000000,
            open: "92000",
            high: "93000",
            low: "91000",
            close: "92500",
            volume: "1.5",
          },
        ],
      });
    const result = await client.getCandles("BTC-USD", { interval: 60 });
    expect(result.data[0].open).toBe("92000");
  });
});

describe("getOrderBook", () => {
  it("returns asks and bids", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/order-book/BTC-USD")
      .query({ limit: "10" })
      .reply(200, {
        data: {
          asks: [
            {
              aid: "BTC",
              anm: "Bitcoin",
              s: "SELL",
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
            },
          ],
          bids: [
            {
              aid: "BTC",
              anm: "Bitcoin",
              s: "BUYI",
              p: "95000",
              pc: "USD",
              pn: "MONE",
              q: "0.5",
              qc: "BTC",
              qn: "UNIT",
              ve: "REVX",
              no: "1",
              ts: "CLOB",
              pdt: 1700000000000,
            },
          ],
        },
        metadata: { timestamp: 1700000000000 },
      });
    const result = await client.getOrderBook("BTC-USD", { limit: 10 });
    expect(result.data.asks[0].s).toBe("SELL");
    expect(result.data.bids[0].s).toBe("BUYI");
  });
});

describe("placeOrder", () => {
  it("places limit order", async () => {
    const client = makeClient();
    nock(BASE)
      .post("/api/1.0/orders")
      .reply(200, {
        data: {
          venue_order_id: "order-123",
          client_order_id: "client-123",
          state: "new",
        },
      });
    const result = await client.placeOrder({
      symbol: "BTC-USD",
      side: "buy",
      limit: { price: "95000", baseSize: "0.001" },
    });
    expect(result.data.venue_order_id).toBe("order-123");
  });

  it("places market order", async () => {
    const client = makeClient();
    nock(BASE)
      .post("/api/1.0/orders")
      .reply(200, {
        data: {
          venue_order_id: "order-456",
          client_order_id: "client-456",
          state: "new",
        },
      });
    const result = await client.placeOrder({
      symbol: "BTC-USD",
      side: "sell",
      market: { baseSize: "0.001" },
    });
    expect(result.data.state).toBe("new");
  });
});

describe("getActiveOrders", () => {
  it("returns paginated orders", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/orders/active")
      .query({ symbols: "BTC-USD" })
      .reply(200, {
        data: [
          {
            id: "o1",
            client_order_id: "c1",
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
          },
        ],
        metadata: { timestamp: 1700000000000 },
      });
    const result = await client.getActiveOrders({ symbols: ["BTC-USD"] });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe("new");
  });
});

describe("getHistoricalOrders", () => {
  it("returns historical orders", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/orders/historical")
      .query({ end_date: "1700086400000", start_date: "1700000000000" })
      .reply(200, {
        data: [],
        metadata: { timestamp: 1700000000000 },
      });
    const result = await client.getHistoricalOrders({
      startDate: 1700000000000,
      endDate: 1700086400000,
    });
    expect(result.data).toHaveLength(0);
  });
});

describe("getOrder", () => {
  it("returns single order", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/orders/order-123")
      .reply(200, {
        data: {
          id: "order-123",
          client_order_id: "c1",
          symbol: "BTC/USD",
          side: "buy",
          type: "limit",
          quantity: "0.1",
          filled_quantity: "0",
          leaves_quantity: "0.1",
          price: "95000",
          status: "new",
          time_in_force: "gtc",
          execution_instructions: [],
          created_date: 1700000000000,
          updated_date: 1700000000000,
        },
      });
    const result = await client.getOrder("order-123");
    expect(result.data.id).toBe("order-123");
  });
});

describe("cancelOrder", () => {
  it("cancels order (204 no content)", async () => {
    const client = makeClient();
    nock(BASE).delete("/api/1.0/orders/order-123").reply(204);
    await expect(client.cancelOrder("order-123")).resolves.toBeUndefined();
  });
});

describe("getOrderFills", () => {
  it("returns trade fills", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/orders/fills/order-123")
      .reply(200, {
        data: [
          {
            tdt: 1700000000000,
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
            tid: "trade-1",
          },
        ],
      });
    const result = await client.getOrderFills("order-123");
    expect(result.data[0].tid).toBe("trade-1");
  });
});

describe("getAllTrades", () => {
  it("returns paginated trades", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/trades/all/BTC-USD")
      .reply(200, {
        data: [
          {
            tdt: 1700000000000,
            aid: "BTC",
            anm: "Bitcoin",
            p: "95000",
            pc: "USD",
            pn: "MONE",
            q: "0.5",
            qc: "BTC",
            qn: "UNIT",
            ve: "REVX",
            pdt: 1700000000000,
            vp: "REVX",
            tid: "t1",
          },
        ],
        metadata: { timestamp: 1700000000000 },
      });
    const result = await client.getAllTrades("BTC-USD");
    expect(result.data).toHaveLength(1);
  });
});

describe("getPrivateTrades", () => {
  it("returns private trades", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/trades/private/BTC-USD")
      .reply(200, {
        data: [],
        metadata: { timestamp: 1700000000000 },
      });
    const result = await client.getPrivateTrades("BTC-USD");
    expect(result.data).toHaveLength(0);
  });
});

describe("getPublicOrderBook", () => {
  it("returns public order book (no auth needed)", async () => {
    const unauthClient = new RevolutXClient({
      baseUrl: BASE,
      maxRetries: 0,
      autoLoadCredentials: false,
    });
    nock(BASE)
      .get("/api/1.0/public/order-book/ETH-USD")
      .reply(200, {
        data: {
          asks: [
            {
              aid: "ETH",
              anm: "Ethereum",
              s: "SELL",
              p: "4600",
              pc: "USD",
              pn: "MONE",
              q: "17",
              qc: "ETH",
              qn: "UNIT",
              ve: "REVX",
              no: "3",
              ts: "CLOB",
              pdt: "2025-01-01T00:00:00Z",
            },
          ],
          bids: [
            {
              aid: "ETH",
              anm: "Ethereum",
              s: "BUYI",
              p: "4550",
              pc: "USD",
              pn: "MONE",
              q: "0.25",
              qc: "ETH",
              qn: "UNIT",
              ve: "REVX",
              no: "1",
              ts: "CLOB",
              pdt: "2025-01-01T00:00:00Z",
            },
          ],
        },
        metadata: { timestamp: "2025-01-01T00:00:00Z" },
      });
    const result = await unauthClient.getPublicOrderBook("ETH-USD");
    expect(result.data.asks[0].s).toBe("SELL");
    expect(result.data.bids[0].s).toBe("BUYI");
  });
});

describe("query encoding", () => {
  it("preserves raw commas in comma-separated params", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/orders/active")
      .query({ order_states: "new,partially_filled", symbols: "BTC-USD" })
      .reply(200, { data: [], metadata: { timestamp: 1700000000000 } });
    const result = await client.getActiveOrders({
      symbols: ["BTC-USD"],
      orderStates: ["new", "partially_filled"],
    });
    expect(result.data).toHaveLength(0);
  });
});

describe("retry behavior", () => {
  it("retries on 429 then succeeds", async () => {
    const client = makeClient({ maxRetries: 1 });
    nock(BASE)
      .get("/api/1.0/balances")
      .reply(429, { message: "Rate limit exceeded" });
    nock(BASE)
      .get("/api/1.0/balances")
      .reply(200, [
        { currency: "BTC", available: "1.0", reserved: "0", total: "1.0" },
      ]);
    const result = await client.getBalances();
    expect(result).toHaveLength(1);
    expect(result[0].currency).toBe("BTC");
  });

  it("retries on 409 then succeeds", async () => {
    const client = makeClient({ maxRetries: 1 });
    nock(BASE)
      .get("/api/1.0/balances")
      .reply(409, { message: "Request timestamp is in the future" });
    nock(BASE)
      .get("/api/1.0/balances")
      .reply(200, [
        { currency: "USD", available: "5000", reserved: "0", total: "5000" },
      ]);
    const result = await client.getBalances();
    expect(result).toHaveLength(1);
  });
});

describe("error handling", () => {
  it("throws AuthNotConfiguredError without credentials", async () => {
    const client = new RevolutXClient({
      baseUrl: BASE,
      autoLoadCredentials: false,
    });
    await expect(client.getBalances()).rejects.toThrow(
      "credentials not configured",
    );
  });

  it("throws AuthenticationError on 401", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/balances")
      .reply(401, { message: "Invalid API key" });
    await expect(client.getBalances()).rejects.toThrow("Invalid API key");
  });

  it("throws NotFoundError on 404", async () => {
    const client = makeClient();
    nock(BASE)
      .get("/api/1.0/orders/bad-id")
      .reply(404, { message: "Order not found" });
    await expect(client.getOrder("bad-id")).rejects.toThrow("Order not found");
  });

  it("throws OrderError on 400", async () => {
    const client = makeClient();
    nock(BASE)
      .post("/api/1.0/orders")
      .reply(400, { message: "Insufficient funds" });
    await expect(
      client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        limit: { price: "95000", baseSize: "999" },
      }),
    ).rejects.toThrow("Insufficient funds");
  });
});

describe("isAuthenticated", () => {
  it("true when credentials provided", () => {
    const client = makeClient();
    expect(client.isAuthenticated).toBe(true);
  });

  it("false without credentials", () => {
    const client = new RevolutXClient({
      baseUrl: BASE,
      autoLoadCredentials: false,
    });
    expect(client.isAuthenticated).toBe(false);
  });
});
