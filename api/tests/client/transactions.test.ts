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
        source_currency: "USD",
        source_amount: "1000.00",
        destination_currency: "BTC",
        destination_amount: "0.01",
        created_date: 1700000000000,
        processed_date: 1700000001000,
      });
    });

    it("handles a destination-only transaction", async () => {
      const client = createTestClient();
      const destinationOnly = {
        ...mockTransaction,
        type: "receive",
        source_currency: undefined,
        source_amount: undefined,
        destination_currency: "USD",
        destination_amount: "14.70",
      };
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [destinationOnly],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0].source_currency).toBeUndefined();
      expect(result.data[0].source_amount).toBeUndefined();
      expect(result.data[0].destination_currency).toBe("USD");
      expect(result.data[0].destination_amount).toBe("14.70");
    });

    it("handles a source-only transaction", async () => {
      const client = createTestClient();
      const sourceOnly = {
        ...mockTransaction,
        type: "send",
        source_currency: "BTC",
        source_amount: "0.01",
        destination_currency: undefined,
        destination_amount: undefined,
      };
      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .reply(200, {
          data: [sourceOnly],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions();

      expect(result.data[0].source_currency).toBe("BTC");
      expect(result.data[0].source_amount).toBe("0.01");
      expect(result.data[0].destination_currency).toBeUndefined();
      expect(result.data[0].destination_amount).toBeUndefined();
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
        .query({ types: "buy,receive" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions({
        types: ["buy", "receive"],
      });

      expect(result.data).toEqual([]);
    });

    it("filters by statuses", async () => {
      const client = createTestClient();

      nock(BASE_URL)
        .get("/api/1.0/transactions")
        .query({ statuses: "completed,pending" })
        .reply(200, {
          data: [mockTransaction],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getTransactions({
        statuses: ["completed", "pending"],
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
});
