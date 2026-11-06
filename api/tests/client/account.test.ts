import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import {
  createTestClient,
  BASE_URL,
  mockBalance,
} from "../helpers/test-utils.js";

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

  describe("getSubAccounts", () => {
    const mockSubAccounts = {
      data: {
        sub_accounts: [
          {
            name: "TradingBot-65",
            total_balance: { amount: "60000.00", currency: "USD" },
            created_date: 1699999940000,
            updated_date: 1700000000000,
          },
          {
            name: "TradingBot-66",
            total_balance: { amount: "0.00", currency: "USD" },
            created_date: 1699999940000,
            updated_date: 1700000000000,
          },
        ],
      },
      metadata: { timestamp: 1700000000000, convert_to: "USD" },
    };

    it("lists sub-accounts with total balances in the target currency", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/sub-accounts").reply(200, mockSubAccounts);

      const result = await client.getSubAccounts();

      expect(result.data.sub_accounts).toHaveLength(2);
      expect(result.data.sub_accounts[0].name).toBe("TradingBot-65");
      expect(result.data.sub_accounts[0].total_balance.amount).toBe("60000.00");
      expect(result.data.sub_accounts[0].total_balance.currency).toBe("USD");
      expect(result.metadata.convert_to).toBe("USD");
    });

    it("passes convert_to through as a query parameter", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/sub-accounts")
        .query({ convert_to: "EUR" })
        .reply(200, {
          data: {
            sub_accounts: [
              {
                name: "TradingBot-65",
                total_balance: { amount: "55000.00", currency: "EUR" },
                created_date: 1699999940000,
                updated_date: 1700000000000,
              },
            ],
          },
          metadata: { timestamp: 1700000000000, convert_to: "EUR" },
        });

      const result = await client.getSubAccounts({ convertTo: "EUR" });

      expect(result.metadata.convert_to).toBe("EUR");
      expect(result.data.sub_accounts[0].total_balance.currency).toBe("EUR");
    });

    it("returns an empty list when there are no sub-accounts", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/sub-accounts")
        .reply(200, {
          data: { sub_accounts: [] },
          metadata: { timestamp: 1700000000000, convert_to: "USD" },
        });

      const result = await client.getSubAccounts();

      expect(result.data.sub_accounts).toEqual([]);
    });
  });
});
