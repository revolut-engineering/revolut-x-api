import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { createTestClient, BASE_URL, mockBalance } from "../helpers/test-utils.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Account Management", () => {
  describe("getBalances", () => {
    it("returns array of account balances", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(200, [
          mockBalance,
          { currency: "USD", available: "5000", reserved: "0", total: "5000" },
        ]);

      const result = await client.getBalances();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        currency: "BTC",
        available: "1.5",
        reserved: "0.1",
        total: "1.6",
      });
    });

    it("returns empty array when no balances", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/balances").reply(200, []);

      const result = await client.getBalances();

      expect(result).toEqual([]);
    });

    it("handles multiple currencies correctly", async () => {
      const client = createTestClient();
      const balances = [
        { currency: "BTC", available: "1.0", reserved: "0", total: "1.0" },
        { currency: "ETH", available: "10.0", reserved: "1.0", total: "11.0" },
        {
          currency: "USD",
          available: "1000.0",
          reserved: "100.0",
          total: "1100.0",
        },
        {
          currency: "USDT",
          available: "500.0",
          reserved: "0",
          total: "500.0",
        },
      ];

      nock(BASE_URL).get("/api/1.0/balances").reply(200, balances);

      const result = await client.getBalances();

      expect(result).toHaveLength(4);
      expect(result.map((b) => b.currency)).toEqual([
        "BTC",
        "ETH",
        "USD",
        "USDT",
      ]);
    });

    it("preserves decimal precision in balance values", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(200, [
          {
            currency: "BTC",
            available: "0.00000001",
            reserved: "0.00000000",
            total: "0.00000001",
          },
        ]);

      const result = await client.getBalances();

      expect(result[0].available).toBe("0.00000001");
      expect(result[0].total).toBe("0.00000001");
    });
  });
});
