import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import {
  createTestClient,
  BASE_URL,
  mockTicker,
  mockCandle,
  mockOrderBookLevel,
} from "../helpers/test-utils.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Market Data", () => {
  describe("getTickers", () => {
    it("returns all tickers when no filter", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/tickers")
        .reply(200, {
          data: [mockTicker],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTickers();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].symbol).toBe("BTC/USD");
      expect(result.metadata.timestamp).toBe(1700000000000);
    });

    it("filters tickers by symbols", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/tickers")
        .query({ symbols: "BTC-USD,ETH-USD" })
        .reply(200, {
          data: [
            mockTicker,
            { ...mockTicker, symbol: "ETH/USD", last_price: "3500" },
          ],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTickers({
        symbols: ["BTC-USD", "ETH-USD"],
      });

      expect(result.data).toHaveLength(2);
    });

    it("includes bid/ask/mid prices", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/tickers")
        .reply(200, {
          data: [mockTicker],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTickers();

      expect(result.data[0]).toMatchObject({
        bid: "95000",
        ask: "95100",
        mid: "95050",
        last_price: "95050",
      });
    });

    it("returns empty array when no tickers available", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/tickers")
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTickers();

      expect(result.data).toEqual([]);
    });
  });

  describe("getCandles", () => {
    it("returns candles with default interval", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/candles/BTC-USD")
        .reply(200, {
          data: [mockCandle],
        });

      const result = await client.getCandles("BTC-USD");

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        open: "92000",
        high: "93000",
        low: "91000",
        close: "92500",
        volume: "1.5",
      });
    });

    it("accepts numeric interval in minutes", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/candles/BTC-USD")
        .query({ interval: "60" })
        .reply(200, { data: [mockCandle] });

      const result = await client.getCandles("BTC-USD", { interval: 60 });

      expect(result.data).toHaveLength(1);
    });

    it("converts string intervals to minutes", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/candles/ETH-USD")
        .query({ interval: "60" })
        .reply(200, { data: [mockCandle] });

      const result = await client.getCandles("ETH-USD", { interval: "1h" });

      expect(result.data).toHaveLength(1);
    });

    it("supports various time intervals", async () => {
      const client = createTestClient();
      const intervals = [
        { string: "5m", minutes: 5 },
        { string: "15m", minutes: 15 },
        { string: "1h", minutes: 60 },
        { string: "4h", minutes: 240 },
        { string: "1d", minutes: 1440 },
      ];

      for (const { string, minutes } of intervals) {
        nock(BASE_URL)
          .get("/api/1.0/candles/BTC-USD")
          .query({ interval: String(minutes) })
          .reply(200, { data: [mockCandle] });

        const result = await client.getCandles("BTC-USD", {
          interval: string,
        });
        expect(result.data).toHaveLength(1);
      }
    });

    it("accepts time range parameters", async () => {
      const client = createTestClient();
      const startDate = 1700000000000;
      const endDate = 1700086400000;

      nock(BASE_URL)
        .get("/api/1.0/candles/BTC-USD")
        .query({ since: String(startDate), until: String(endDate) })
        .reply(200, { data: [mockCandle, mockCandle] });

      const result = await client.getCandles("BTC-USD", { startDate, endDate });

      expect(result.data).toHaveLength(2);
    });
  });

  describe("getOrderBook", () => {
    it("returns order book with bids and asks", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/order-book/BTC-USD")
        .reply(200, {
          data: {
            asks: [mockOrderBookLevel],
            bids: [{ ...mockOrderBookLevel, s: "BUYI", p: "95000" }],
          },
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getOrderBook("BTC-USD");

      expect(result.data.asks).toHaveLength(1);
      expect(result.data.bids).toHaveLength(1);
      expect(result.data.asks[0].s).toBe("SELL");
      expect(result.data.bids[0].s).toBe("BUYI");
    });

    it("respects limit parameter", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/order-book/BTC-USD")
        .query({ limit: "10" })
        .reply(200, {
          data: { asks: [], bids: [] },
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getOrderBook("BTC-USD", { limit: 10 });

      expect(result.data).toBeDefined();
    });

    it("includes price and quantity information", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/order-book/ETH-USD")
        .reply(200, {
          data: {
            asks: [mockOrderBookLevel],
            bids: [],
          },
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getOrderBook("ETH-USD");

      expect(result.data.asks[0]).toMatchObject({
        p: "95100",
        q: "1",
        pc: "USD",
        qc: "BTC",
      });
    });
  });
});
