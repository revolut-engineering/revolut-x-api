import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { createTestClient, BASE_URL, mockTrade } from "../helpers/test-utils.js";

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
      expect(result.data[0].tid).toBe("trade-1");
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

    it("includes trade details (price, quantity, timestamp)", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/all/BTC-USD")
        .reply(200, {
          data: [mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getAllTrades("BTC-USD");

      expect(result.data[0]).toMatchObject({
        p: "95000",
        q: "0.001",
        tdt: 1700000000000,
      });
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
      expect(result.data[0].tid).toBe("trade-1");
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

    it("includes all trade information", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/trades/private/BTC-USD")
        .reply(200, {
          data: [mockTrade],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getPrivateTrades("BTC-USD");

      expect(result.data[0]).toMatchObject({
        aid: "BTC",
        anm: "Bitcoin",
        p: "95000",
        pc: "USD",
        q: "0.001",
        qc: "BTC",
        ve: "REVX",
      });
    });
  });
});
