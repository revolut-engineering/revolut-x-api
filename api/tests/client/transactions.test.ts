import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import {
  createTestClient,
  BASE_URL,
  mockTransaction,
} from "../helpers/test-utils.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Transactions", () => {
  describe("getTransactions", () => {
    it("returns transactions list", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [mockTransaction],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(mockTransaction.id);
    });

    it("maps response fields correctly", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [mockTransaction],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0]).toMatchObject({
        id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
        status: "completed",
        type: "buy",
        source: { amount: "1000.00", currency: "USD" },
        destination: { amount: "0.01", currency: "BTC" },
        created_date: 1700000000000,
        processed_date: 1700000001000,
      });
    });

    it("handles a destination-only transaction", async () => {
      const client = createTestClient();
      const destinationOnly = {
        ...mockTransaction,
        type: "receive",
        source: undefined,
        destination: { amount: "14.70", currency: "USD" },
      };
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [destinationOnly],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0].source).toBeUndefined();
      expect(result.data[0].destination).toEqual({
        amount: "14.70",
        currency: "USD",
      });
    });

    it("handles a source-only transaction", async () => {
      const client = createTestClient();
      const sourceOnly = {
        ...mockTransaction,
        type: "send",
        source: { amount: "0.01", currency: "BTC" },
        destination: undefined,
      };
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [sourceOnly],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0].source).toEqual({
        amount: "0.01",
        currency: "BTC",
      });
      expect(result.data[0].destination).toBeUndefined();
    });

    it("includes per-leg account types", async () => {
      const client = createTestClient();
      const transactions = [
        {
          ...mockTransaction,
          source: {
            amount: "1000.00",
            currency: "USD",
            account: { type: "revolut" },
          },
          destination: {
            amount: "0.01",
            currency: "BTC",
            account: { type: "revolut_x" },
          },
        },
        {
          ...mockTransaction,
          id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
          type: "send",
          source: {
            amount: "0.01",
            currency: "BTC",
            account: { type: "revolut_x" },
          },
          destination: undefined,
        },
        {
          ...mockTransaction,
          id: "c3d4e5f6-a7b8-9012-cdef-234567890123",
          type: "receive",
          source: undefined,
          destination: {
            amount: "0.01",
            currency: "BTC",
            account: { type: "revolut_x" },
          },
        },
      ];
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: transactions,
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0].source?.account).toEqual({ type: "revolut" });
      expect(result.data[0].destination?.account).toEqual({
        type: "revolut_x",
      });
      expect(result.data[1].source?.account).toEqual({ type: "revolut_x" });
      expect(result.data[1].destination).toBeUndefined();
      expect(result.data[2].source).toBeUndefined();
      expect(result.data[2].destination?.account).toEqual({
        type: "revolut_x",
      });
    });

    it("handles optional processed_date", async () => {
      const client = createTestClient();
      const txPending = {
        ...mockTransaction,
        status: "pending",
        processed_date: undefined,
      };
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [txPending],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0].status).toBe("pending");
      expect(result.data[0].processed_date).toBeUndefined();
    });

    it("handles a cancelled transaction status", async () => {
      const client = createTestClient();
      const txCancelled = {
        ...mockTransaction,
        status: "cancelled",
      };
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [txCancelled],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0].status).toBe("cancelled");
    });

    it("filters by date range", async () => {
      const client = createTestClient();
      const startDate = 1700000000000;
      const endDate = 1700086400000;

      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .query({
          start_date: String(startDate),
          end_date: String(endDate),
        })
        .reply(200, {
          data: [mockTransaction],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions({ startDate, endDate });

      expect(result.data).toHaveLength(1);
    });

    it("filters by types", async () => {
      const client = createTestClient();

      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .query({ types: "buy,sell,receive,send,stake,un_stake,reward" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions({
        types: [
          "buy",
          "sell",
          "receive",
          "send",
          "stake",
          "un_stake",
          "reward",
        ],
      });

      expect(result.data).toEqual([]);
    });

    it("filters by statuses", async () => {
      const client = createTestClient();

      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .query({ statuses: "completed,pending,cancelled" })
        .reply(200, {
          data: [mockTransaction],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions({
        statuses: ["completed", "pending", "cancelled"],
      });

      expect(result.data).toHaveLength(1);
    });

    it("filters by currencies", async () => {
      const client = createTestClient();

      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .query({ currencies: "BTC,USD" })
        .reply(200, {
          data: [mockTransaction],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions({
        currencies: ["BTC", "USD"],
      });

      expect(result.data).toHaveLength(1);
    });

    it("supports pagination with cursor and limit", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .query({ cursor: "next-page", limit: "100" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      await client.getTransactions({ cursor: "next-page", limit: 100 });
    });

    it("passes all filters combined", async () => {
      const client = createTestClient();
      const startDate = 1700000000000;
      const endDate = 1700086400000;

      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .query({
          start_date: String(startDate),
          end_date: String(endDate),
          types: "buy",
          statuses: "completed",
          currencies: "BTC",
          limit: "50",
        })
        .reply(200, {
          data: [mockTransaction],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions({
        startDate,
        endDate,
        types: ["buy"],
        statuses: ["completed"],
        currencies: ["BTC"],
        limit: 50,
      });

      expect(result.data).toHaveLength(1);
    });

    it("returns empty array when no transactions", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data).toEqual([]);
    });

    it("returns next_cursor in metadata", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [mockTransaction],
          metadata: {
            timestamp: 1700000000000,
            next_cursor: "base64encodedcursor",
          },
        });

      const result = await client.getTransactions();

      expect(result.metadata.next_cursor).toBe("base64encodedcursor");
    });
  });

  describe("getTransaction", () => {
    const mockTransactionDetails = {
      ...mockTransaction,
      source: {
        amount: "1000.00",
        currency: "USD",
        fee: "1.00",
        fee_currency: "USD",
        account: {
          type: "revolut_x",
          display_name: "Crypto Primary",
        },
      },
      destination: {
        amount: "0.01",
        currency: "BTC",
        account: {
          type: "revolut_x",
          display_name: "Crypto Primary",
        },
      },
      description: "Test transaction",
    };

    it("returns transaction details for an id", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get(`/api/1.0/transactions/${mockTransaction.id}`)
        .reply(200, mockTransactionDetails);

      const result = await client.getTransaction(mockTransaction.id);

      expect(result.id).toBe(mockTransaction.id);
      expect(result.status).toBe("completed");
      expect(result.type).toBe("buy");
    });

    it("maps detail fields correctly", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get(`/api/1.0/transactions/${mockTransaction.id}`)
        .reply(200, {
          ...mockTransactionDetails,
          order_id: "order-123",
          crypto_transaction_hash: "0xabc123",
          network: "Ethereum",
        });

      const result = await client.getTransaction(mockTransaction.id);

      expect(result.source).toMatchObject({
        amount: "1000.00",
        currency: "USD",
        fee: "1.00",
        fee_currency: "USD",
      });
      expect(result.destination).toMatchObject({
        amount: "0.01",
        currency: "BTC",
      });
      expect(result.source?.account).toEqual({
        type: "revolut_x",
        display_name: "Crypto Primary",
      });
      expect(result.description).toBe("Test transaction");
      expect(result.order_id).toBe("order-123");
      expect(result.crypto_transaction_hash).toBe("0xabc123");
      expect(result.network).toBe("Ethereum");
    });

    it("handles an external crypto account with address", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get(`/api/1.0/transactions/${mockTransaction.id}`)
        .reply(200, {
          ...mockTransactionDetails,
          type: "receive",
          source: {
            amount: "0.5",
            currency: "ETH",
            account: {
              type: "external_crypto",
              display_name: "Binance",
              crypto_address: "0xdeadbeef",
            },
          },
          destination: {
            amount: "0.5",
            currency: "ETH",
            account: {
              type: "revolut_x",
              display_name: "Crypto Primary",
            },
          },
        });

      const result = await client.getTransaction(mockTransaction.id);

      expect(result.source?.account).toEqual({
        type: "external_crypto",
        display_name: "Binance",
        crypto_address: "0xdeadbeef",
      });
      expect(result.destination?.account).toEqual({
        type: "revolut_x",
        display_name: "Crypto Primary",
      });
    });

    it("shows only the source leg with an account for a stake", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get(`/api/1.0/transactions/${mockTransaction.id}`)
        .reply(200, {
          ...mockTransactionDetails,
          type: "stake",
          source: {
            amount: "0.01",
            currency: "BTC",
            account: {
              type: "revolut_x",
              display_name: "Crypto Primary",
            },
          },
          destination: undefined,
        });

      const result = await client.getTransaction(mockTransaction.id);

      expect(result.source?.account).toEqual({
        type: "revolut_x",
        display_name: "Crypto Primary",
      });
      expect(result.destination).toBeUndefined();
    });

    it("handles a sub-account as a transaction leg account", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get(`/api/1.0/transactions/${mockTransaction.id}`)
        .reply(200, {
          ...mockTransactionDetails,
          type: "send",
          destination: {
            amount: "0.01",
            currency: "BTC",
            account: {
              type: "revolut_x",
              display_name: "My X Account",
            },
          },
        });

      const result = await client.getTransaction(mockTransaction.id);

      expect(result.destination?.account).toEqual({
        type: "revolut_x",
        display_name: "My X Account",
      });
    });

    it("handles a destination-only detail without extra fields", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get(`/api/1.0/transactions/${mockTransaction.id}`)
        .reply(200, {
          id: mockTransaction.id,
          status: "completed",
          type: "reward",
          destination: { amount: "0.0001", currency: "ETH" },
          created_date: 1700000000000,
        });

      const result = await client.getTransaction(mockTransaction.id);

      expect(result.destination).toEqual({
        amount: "0.0001",
        currency: "ETH",
      });
      expect(result.source).toBeUndefined();
      expect(result.description).toBeUndefined();
      expect(result.processed_date).toBeUndefined();
    });

    it("throws NotFoundError for an unknown id", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/transactions/does-not-exist").reply(404, {
        message: "Transaction not found",
        error_id: "err-1",
        timestamp: 1700000000000,
      });

      await expect(client.getTransaction("does-not-exist")).rejects.toThrow();
    });
  });
});
