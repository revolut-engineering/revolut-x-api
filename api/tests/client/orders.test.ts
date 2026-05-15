import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import {
  createTestClient,
  BASE_URL,
  mockOrder,
} from "../helpers/test-utils.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Orders", () => {
  describe("placeOrder", () => {
    it("places limit order with baseSize", async () => {
      const client = createTestClient();
      nock(BASE_URL)
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
      expect(result.data.state).toBe("new");
    });

    it("places limit order with quoteSize", async () => {
      const client = createTestClient();
      nock(BASE_URL)
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
        limit: { price: "95000", quoteSize: "100" },
      });

      expect(result.data.venue_order_id).toBe("order-456");
    });

    it("places market order with baseSize", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(200, {
          data: {
            venue_order_id: "order-789",
            client_order_id: "client-789",
            state: "new",
          },
        });

      const result = await client.placeOrder({
        symbol: "ETH-USD",
        side: "buy",
        market: { baseSize: "1.0" },
      });

      expect(result.data.state).toBe("new");
    });

    it("places market order with quoteSize", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(200, {
          data: {
            venue_order_id: "order-abc",
            client_order_id: "client-abc",
            state: "new",
          },
        });

      const result = await client.placeOrder({
        symbol: "ETH-USD",
        side: "sell",
        market: { quoteSize: "1000" },
      });

      expect(result.data.venue_order_id).toBe("order-abc");
    });

    it("generates client order ID if not provided", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-123",
            client_order_id: capturedBody?.client_order_id,
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        limit: { price: "95000", baseSize: "0.001" },
      });

      expect(capturedBody.client_order_id).toBeDefined();
      expect(typeof capturedBody.client_order_id).toBe("string");
    });

    it("uses provided client order ID", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-123",
            client_order_id: "my-custom-id",
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        clientOrderId: "my-custom-id",
        limit: { price: "95000", baseSize: "0.001" },
      });

      expect(capturedBody.client_order_id).toBe("my-custom-id");
    });

    it("includes execution instructions for limit orders", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-123",
            client_order_id: "client-123",
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        limit: {
          price: "95000",
          baseSize: "0.001",
          executionInstructions: ["post_only"],
        },
      });

      const config = capturedBody.order_configuration as {
        limit: { execution_instructions: string[] };
      };
      expect(config.limit.execution_instructions).toEqual(["post_only"]);
    });
  });

  describe("getActiveOrders", () => {
    it("returns paginated active orders", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .reply(200, {
          data: [mockOrder],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getActiveOrders();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].status).toBe("new");
    });

    it("filters by symbols", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .query({ symbols: "BTC-USD,ETH-USD" })
        .reply(200, {
          data: [mockOrder],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getActiveOrders({
        symbols: ["BTC-USD", "ETH-USD"],
      });

      expect(result.data).toBeDefined();
    });

    it("filters by order states", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .query({ order_states: "new,partially_filled" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getActiveOrders({
        orderStates: ["new", "partially_filled"],
      });

      expect(result.data).toEqual([]);
    });

    it("filters by order types", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .query({ order_types: "limit" })
        .reply(200, {
          data: [mockOrder],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getActiveOrders({
        orderTypes: ["limit"],
      });

      expect(result.data).toHaveLength(1);
    });

    it("filters by side", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .query({ side: "buy" })
        .reply(200, {
          data: [mockOrder],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getActiveOrders({ side: "buy" });

      expect(result.data[0].side).toBe("buy");
    });

    it("supports pagination with cursor", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .query({ cursor: "next-page-token", limit: "50" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      await client.getActiveOrders({
        cursor: "next-page-token",
        limit: 50,
      });
    });
  });

  describe("getHistoricalOrders", () => {
    it("returns historical orders", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .reply(200, {
          data: [{ ...mockOrder, status: "filled" }],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getHistoricalOrders();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].status).toBe("filled");
    });

    it("filters by date range", async () => {
      const client = createTestClient();
      const startDate = 1700000000000;
      const endDate = 1700086400000;

      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .query({
          start_date: String(startDate),
          end_date: String(endDate),
        })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getHistoricalOrders({
        startDate,
        endDate,
      });

      expect(result.data).toEqual([]);
    });

    it("supports all filter options", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .query({
          symbols: "BTC-USD",
          order_states: "filled",
          order_types: "limit",
        })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      await client.getHistoricalOrders({
        symbols: ["BTC-USD"],
        orderStates: ["filled"],
        orderTypes: ["limit"],
      });
    });

    it("handles partially_filled by querying cancelled orders and remapping correctly", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .query({ order_states: "cancelled" })
        .reply(200, {
          data: [
            { ...mockOrder, status: "cancelled", filled_quantity: "0.5" },
            { ...mockOrder, status: "cancelled", filled_quantity: "0" },
          ],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getHistoricalOrders({
        orderStates: ["partially_filled"],
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].status).toBe("partially_filled");
      expect(result.data[0].filled_quantity).toBe("0.5");
    });

    it("combines partially_filled with other states in the requested query", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .query({ order_states: "filled,cancelled" })
        .reply(200, {
          data: [
            { ...mockOrder, status: "filled", filled_quantity: "1.0" },
            { ...mockOrder, status: "cancelled", filled_quantity: "0.5" },
          ],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getHistoricalOrders({
        orderStates: ["filled", "partially_filled"],
      });

      expect(result.data).toHaveLength(2);
      const statuses = result.data.map((o) => o.status);
      expect(statuses).toContain("filled");
      expect(statuses).toContain("partially_filled");
    });
  });

  describe("getOrder", () => {
    it("returns single order by ID", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/orders/order-123").reply(200, {
        data: mockOrder,
      });

      const result = await client.getOrder("order-123");

      expect(result.data.id).toBe("order-123");
      expect(result.data.symbol).toBe("BTC/USD");
    });

    it("includes all order details", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/orders/order-456").reply(200, {
        data: mockOrder,
      });

      const result = await client.getOrder("order-456");

      expect(result.data).toMatchObject({
        type: "limit",
        quantity: "0.1",
        price: "95000",
        time_in_force: "gtc",
      });
    });

    it("includes total_fee and fee_currency when present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-789")
        .reply(200, {
          data: { ...mockOrder, total_fee: "2.50", fee_currency: "USD" },
        });

      const result = await client.getOrder("order-789");

      expect(result.data.total_fee).toBe("2.50");
      expect(result.data.fee_currency).toBe("USD");
    });

    it("includes filled_amount when present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-789")
        .reply(200, {
          data: { ...mockOrder, amount: "100", filled_amount: "95" },
        });

      const result = await client.getOrder("order-789");

      expect(result.data.amount).toBe("100");
      expect(result.data.filled_amount).toBe("95");
    });

    it("remaps cancelled order with partial fill to partially_filled", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-cancelled-partial")
        .reply(200, {
          data: { ...mockOrder, status: "cancelled", filled_quantity: "0.5" },
        });

      const result = await client.getOrder("order-cancelled-partial");

      expect(result.data.status).toBe("partially_filled");
      expect(result.data.filled_quantity).toBe("0.5");
    });

    it("remaps canceled (US spelling) order with partial fill to partially_filled", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-canceled-partial")
        .reply(200, {
          data: { ...mockOrder, status: "canceled", filled_quantity: "0.5" },
        });

      const result = await client.getOrder("order-canceled-partial");

      expect(result.data.status).toBe("partially_filled");
    });

    it("keeps cancelled status when order has zero fills", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-cancelled-empty")
        .reply(200, {
          data: { ...mockOrder, status: "cancelled", filled_quantity: "0" },
        });

      const result = await client.getOrder("order-cancelled-empty");

      expect(result.data.status).toBe("cancelled");
    });
  });

  describe("replaceOrder", () => {
    it("replaces order with baseSize", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-999",
            client_order_id: "client-new",
            state: "new",
          },
        });

      const result = await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        baseSize: "0.002",
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        base_size: "0.002",
      });
      expect(result.data.venue_order_id).toBe("order-999");
      expect(result.data.state).toBe("new");
    });

    it("replaces order with price", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-price",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        price: "96000",
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        price: "96000",
      });
    });

    it("replaces order with quoteSize", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-1000",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        quoteSize: "200",
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        quote_size: "200",
      });
    });

    it("replaces order with executionInstructions allow_taker explicitly", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-1001",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        executionInstructions: ["allow_taker"],
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        execution_instructions: ["allow_taker"],
      });
    });

    it("replaces order with multiple fields", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-1002",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        price: "97000",
        baseSize: "0.5",
        quoteSize: "100",
        executionInstructions: ["post_only"],
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        price: "97000",
        base_size: "0.5",
        quote_size: "100",
        execution_instructions: ["post_only"],
      });
    });

    it("throws when no replaceable field provided", async () => {
      const client = createTestClient();
      await expect(
        client.replaceOrder("order-123", { clientOrderId: "client-new" }),
      ).rejects.toThrow("Invalid replace order parameters");
    });

    it("throws when clientOrderId is empty", async () => {
      const client = createTestClient();
      await expect(
        client.replaceOrder("order-123", {
          clientOrderId: "",
          baseSize: "0.001",
        }),
      ).rejects.toThrow();
    });

    it("requires authentication", async () => {
      const client = createTestClient({ authenticated: false });
      await expect(
        client.replaceOrder("order-123", {
          clientOrderId: "client-new",
          baseSize: "0.001",
        }),
      ).rejects.toThrow("Revolut X credentials not configured");
    });
  });

  describe("cancelOrder", () => {
    it("cancels order successfully (204 no content)", async () => {
      const client = createTestClient();
      nock(BASE_URL).delete("/api/1.0/orders/order-123").reply(204);

      await expect(client.cancelOrder("order-123")).resolves.toBeUndefined();
    });

    it("handles various order IDs", async () => {
      const client = createTestClient();
      const orderIds = ["order-123", "abc-def-ghi", "12345"];

      for (const orderId of orderIds) {
        nock(BASE_URL).delete(`/api/1.0/orders/${orderId}`).reply(204);
        await expect(client.cancelOrder(orderId)).resolves.toBeUndefined();
      }
    });
  });

  describe("cancelAllOrders", () => {
    it("cancels all orders successfully (204 no content)", async () => {
      const client = createTestClient();
      nock(BASE_URL).delete("/api/1.0/orders").reply(204);

      await expect(client.cancelAllOrders()).resolves.toBeUndefined();
    });

    it("requires authentication", async () => {
      const client = createTestClient({ authenticated: false });

      await expect(client.cancelAllOrders()).rejects.toThrow(
        "Revolut X credentials not configured",
      );
    });
  });

  describe("getOrderFills", () => {
    const mockFill = {
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
      im: true,
    };

    it("returns mapped trade fills for an order", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/fills/order-123")
        .reply(200, { data: [mockFill] });

      const result = await client.getOrderFills("order-123");

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: "12345678-1234-1234-1234-123456789abc",
        symbol: "BTC/USD",
        price: "95000",
        quantity: "0.001",
        side: "buy",
        orderId: "d0184248-2de5-4b2a-9fe2-0cf42670da47",
        maker: true,
        timestamp: 1700000000000,
      });
    });

    it("returns empty array for unfilled order", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/orders/fills/order-456").reply(200, {
        data: [],
      });

      const result = await client.getOrderFills("order-456");

      expect(result.data).toEqual([]);
    });

    it("handles multiple fills", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/fills/order-789")
        .reply(200, {
          data: [
            { ...mockFill, p: "95000", q: "0.0005", tdt: 1700000000000 },
            { ...mockFill, p: "95010", q: "0.0005", tdt: 1700000100000 },
          ],
        });

      const result = await client.getOrderFills("order-789");

      expect(result.data).toHaveLength(2);
      expect(result.data[0].price).toBe("95000");
      expect(result.data[1].price).toBe("95010");
    });
  });
});
