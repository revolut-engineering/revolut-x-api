import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import {
  createTestClient,
  BASE_URL,
  mockTrade,
} from "../helpers/test-utils.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Trades", () => {
  describe("getAllTrades", () => {
    it("returns all public trades for a symbol", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/all/BTC-USD")
        .reply(200, {
          data: [mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getAllTrades("BTC-USD");

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("12345678-1234-1234-1234-123456789abc");
    });

    it("maps wire fields to clean schema", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/all/BTC-USD")
        .reply(200, {
          data: [mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getAllTrades("BTC-USD");

      expect(result.data[0]).toMatchObject({
        id: "12345678-1234-1234-1234-123456789abc",

        symbol: "BTC/USD",
        price: "95000",
        quantity: "0.001",
        timestamp: 1700000000000,
      });
    });

    it("filters by date range", async () => {
      const client = createTestClient();
      const startDate = 1700000000000;
      const endDate = 1700086400000;

      nock(BASE_URL)
        .get("/api/1.0/trades/all/ETH-USD")
        .query({
          start_date: String(startDate),
          end_date: String(endDate),
        })
        .reply(200, {
          data: [mockTrade, mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getAllTrades("ETH-USD", {
        startDate,
        endDate,
      });

      expect(result.data).toHaveLength(2);
    });

    it("supports pagination", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/all/BTC-USD")
        .query({ cursor: "next-page", limit: "100" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      await client.getAllTrades("BTC-USD", {
        cursor: "next-page",
        limit: 100,
      });
    });

    it("returns empty array when no trades", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/all/SOL-USD")
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getAllTrades("SOL-USD");

      expect(result.data).toEqual([]);
    });
  });

  describe("getPrivateTrades", () => {
    it("returns user's private trades for a symbol", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/private/BTC-USD")
        .reply(200, {
          data: [mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getPrivateTrades("BTC-USD");

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("12345678-1234-1234-1234-123456789abc");
    });

    it("maps wire fields to clean schema", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/private/BTC-USD")
        .reply(200, {
          data: [mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getPrivateTrades("BTC-USD");

      expect(result.data[0]).toMatchObject({
        id: "12345678-1234-1234-1234-123456789abc",

        symbol: "BTC/USD",
        price: "95000",
        quantity: "0.001",
        side: "buy",
        orderId: "d0184248-2de5-4b2a-9fe2-0cf42670da47",
        maker: false,
        timestamp: 1700000000000,
      });
    });

    it("passes side through as-is", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/private/BTC-USD")
        .reply(200, {
          data: [
            { ...mockTrade, s: "buy" },
            { ...mockTrade, s: "sell" },
          ],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getPrivateTrades("BTC-USD");

      expect(result.data[0].side).toBe("buy");
      expect(result.data[1].side).toBe("sell");
    });

    it("maps is-maker flag to boolean", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/private/BTC-USD")
        .reply(200, {
          data: [
            { ...mockTrade, im: true },
            { ...mockTrade, im: false },
          ],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getPrivateTrades("BTC-USD");

      expect(result.data[0].maker).toBe(true);
      expect(result.data[1].maker).toBe(false);
    });

    it("returns empty array when user has no trades", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/private/ETH-USD")
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getPrivateTrades("ETH-USD");

      expect(result.data).toEqual([]);
    });

    it("filters by date range", async () => {
      const client = createTestClient();
      const startDate = 1700000000000;
      const endDate = 1700086400000;

      nock(BASE_URL)
        .get("/api/1.0/trades/private/BTC-USD")
        .query({
          start_date: String(startDate),
          end_date: String(endDate),
        })
        .reply(200, {
          data: [mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getPrivateTrades("BTC-USD", {
        startDate,
        endDate,
      });

      expect(result.data).toHaveLength(1);
    });

    it("supports pagination with cursor and limit", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/private/SOL-USD")
        .query({ cursor: "page2", limit: "50" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      await client.getPrivateTrades("SOL-USD", {
        cursor: "page2",
        limit: 50,
      });
    });
  });
});
