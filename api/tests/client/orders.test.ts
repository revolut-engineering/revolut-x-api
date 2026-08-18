import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import {
  createTestClient,
  BASE_URL,
  mockOrder,
  mockTwapOrder,
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

    it("includes time_in_force for limit orders", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tif",
            client_order_id: "client-tif",
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        limit: {
          price: "95000",
          baseSize: "0.001",
          timeInForce: "ioc",
        },
      });

      const config = capturedBody.order_configuration as {
        limit: { time_in_force: string };
      };
      expect(config.limit.time_in_force).toBe("ioc");
    });

    it("places tpsl order with take_profit for a sell (exits on price rise)", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tpsl-1",
            client_order_id: "client-tpsl-1",
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "sell",
        tpsl: {
          baseSize: "0.001",
          takeProfit: { triggerPrice: "100000" },
        },
      });

      const config = capturedBody.order_configuration as {
        base_size: string;
        take_profit: { trigger_price: string; trigger_direction: string };
      };
      expect(config.base_size).toBe("0.001");
      expect(config.take_profit).toEqual({
        trigger_price: "100000",
        trigger_direction: "ge",
        type: "market",
      });
    });

    it("places tpsl order with stop_loss for a sell (exits on price drop)", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tpsl-2",
            client_order_id: "client-tpsl-2",
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "sell",
        tpsl: {
          baseSize: "0.001",
          stopLoss: { triggerPrice: "90000" },
        },
      });

      const config = capturedBody.order_configuration as {
        stop_loss: { trigger_price: string; trigger_direction: string };
      };
      expect(config.stop_loss).toEqual({
        trigger_price: "90000",
        trigger_direction: "le",
        type: "market",
      });
    });

    it("places tpsl order with both take_profit and stop_loss for a buy", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tpsl-3",
            client_order_id: "client-tpsl-3",
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        tpsl: {
          quoteSize: "100",
          takeProfit: { triggerPrice: "100000" },
          stopLoss: { triggerPrice: "90000" },
        },
      });

      const config = capturedBody.order_configuration as {
        quote_size: string;
        take_profit: { trigger_price: string; trigger_direction: string };
        stop_loss: { trigger_price: string; trigger_direction: string };
      };
      expect(config.quote_size).toBe("100");
      expect(config.take_profit).toEqual({
        trigger_price: "100000",
        trigger_direction: "le",
        type: "market",
      });
      expect(config.stop_loss).toEqual({
        trigger_price: "90000",
        trigger_direction: "ge",
        type: "market",
      });
    });

    it("includes limit_price, time_in_force, and execution_instructions on tpsl trigger", async () => {
      const client = createTestClient();
      let capturedBody: Record<string, unknown>;

      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tpsl-4",
            client_order_id: "client-tpsl-4",
            state: "new",
          },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        tpsl: {
          baseSize: "0.001",
          takeProfit: {
            triggerPrice: "100000",
            type: "limit",
            limitPrice: "99900",
            timeInForce: "gtc",
            executionInstructions: ["post_only"],
          },
        },
      });

      const config = capturedBody.order_configuration as {
        take_profit: {
          type: string;
          limit_price: string;
          time_in_force: string;
          execution_instructions: string[];
        };
      };
      expect(config.take_profit.type).toBe("limit");
      expect(config.take_profit.limit_price).toBe("99900");
      expect(config.take_profit.time_in_force).toBe("gtc");
      expect(config.take_profit.execution_instructions).toEqual(["post_only"]);
    });

    it("rejects tpsl order without baseSize or quoteSize", async () => {
      const client = createTestClient();
      await expect(
        client.placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          tpsl: { takeProfit: { triggerPrice: "100000" } },
        }),
      ).rejects.toThrow();
    });

    it("rejects tpsl order without takeProfit or stopLoss", async () => {
      const client = createTestClient();
      await expect(
        client.placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          tpsl: { baseSize: "0.001" },
        }),
      ).rejects.toThrow();
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

    it("returns twap orders with twap details", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .reply(200, {
          data: [mockTwapOrder],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getActiveOrders();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("twap");
      expect(result.data[0].twap).toBeDefined();
      expect(result.data[0].twap!.type).toBe("market");
      expect(result.data[0].twap!.period).toBe(300);
      expect(result.data[0].twap!.frequency).toBe(30);
      expect(result.data[0].twap!.total_slices).toBe(10);
      expect(result.data[0].twap!.completed_slices).toBe(1);
      expect(result.data[0].twap!.start_date).toBe(1783067249312);
      expect(result.data[0].twap!.end_date).toBe(1783067549312);
      expect(result.data[0].twap?.linked_ids).toBeUndefined();
    });

    it("filters by twap order type", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/active")
        .query({ order_types: "twap" })
        .reply(200, {
          data: [mockTwapOrder],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getActiveOrders({
        orderTypes: ["twap"],
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("twap");
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

    it("supports conditional and tpsl order types", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .query({ order_types: "conditional,tpsl" })
        .reply(200, {
          data: [],
          metadata: { timestamp: 1700000000000 },
        });

      await client.getHistoricalOrders({
        orderTypes: ["conditional", "tpsl"],
      });
    });

    it("returns twap orders with twap details in historical", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .reply(200, {
          data: [{ ...mockTwapOrder, status: "filled" }],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getHistoricalOrders();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("twap");
      expect(result.data[0].twap).toBeDefined();
      expect(result.data[0].twap!.type).toBe("market");
      expect(result.data[0].twap?.linked_ids).toBeUndefined();
    });

    it("supports twap order type filter", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/historical")
        .query({ order_types: "twap" })
        .reply(200, {
          data: [mockTwapOrder],
          metadata: { timestamp: 1700000000000 },
        });

      const result = await client.getHistoricalOrders({
        orderTypes: ["twap"],
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("twap");
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

    it("includes triggered_by with conditional reason when present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-triggered")
        .reply(200, {
          data: {
            ...mockOrder,
            triggered_by: {
              conditional: {
                trigger_price: "1000",
                type: "limit",
                trigger_direction: "le",
                limit_price: "1001",
                time_in_force: "gtc",
                execution_instructions: ["allow_taker"],
              },
              reason: "conditional",
            },
          },
        });

      const result = await client.getOrder("order-triggered");

      expect(result.data.triggered_by).toBeDefined();
      expect(result.data.triggered_by!.reason).toBe("conditional");
      expect(result.data.triggered_by!.conditional).toBeDefined();
      expect(result.data.triggered_by!.conditional!.trigger_price).toBe("1000");
    });

    it("includes triggered_by with take_profit reason when present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-tp-trigger")
        .reply(200, {
          data: {
            ...mockOrder,
            triggered_by: {
              take_profit: {
                trigger_price: "100000",
                type: "market",
                trigger_direction: "ge",
                time_in_force: "ioc",
                execution_instructions: ["allow_taker"],
              },
              stop_loss: {
                trigger_price: "80000",
                type: "market",
                trigger_direction: "le",
                time_in_force: "ioc",
                execution_instructions: ["allow_taker"],
              },
              reason: "take_profit",
            },
          },
        });

      const result = await client.getOrder("order-tp-trigger");

      expect(result.data.triggered_by).toBeDefined();
      expect(result.data.triggered_by!.reason).toBe("take_profit");
      expect(result.data.triggered_by!.take_profit).toBeDefined();
      expect(result.data.triggered_by!.stop_loss).toBeDefined();
    });

    it("includes on_fill with linked order id when present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-onfill")
        .reply(200, {
          data: {
            ...mockOrder,
            status: "filled",
            filled_quantity: "0.1",
            leaves_quantity: "0",
            on_fill: {
              take_profit: {
                trigger_price: "100000",
                type: "market",
                trigger_direction: "ge",
                time_in_force: "ioc",
                execution_instructions: ["allow_taker"],
              },
              stop_loss: {
                trigger_price: "1000",
                type: "market",
                trigger_direction: "le",
                time_in_force: "ioc",
                execution_instructions: ["allow_taker"],
              },
              id: "794b48be-9f32-46b4-a9cc-38ca8ea227ac",
            },
          },
        });

      const result = await client.getOrder("order-onfill");

      expect(result.data.on_fill).toBeDefined();
      expect(result.data.on_fill!.id).toBe(
        "794b48be-9f32-46b4-a9cc-38ca8ea227ac",
      );
      expect(result.data.on_fill!.take_profit).toBeDefined();
      expect(result.data.on_fill!.stop_loss).toBeDefined();
    });

    it("includes on_fill without id when order is not filled", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-onfill-no-id")
        .reply(200, {
          data: {
            ...mockOrder,
            on_fill: {
              take_profit: {
                trigger_price: "100000",
                type: "market",
                trigger_direction: "ge",
                time_in_force: "ioc",
                execution_instructions: ["allow_taker"],
              },
              stop_loss: {
                trigger_price: "1000",
                type: "market",
                trigger_direction: "le",
                time_in_force: "ioc",
                execution_instructions: ["allow_taker"],
              },
            },
          },
        });

      const result = await client.getOrder("order-onfill-no-id");

      expect(result.data.on_fill).toBeDefined();
      expect(result.data.on_fill!.id).toBeUndefined();
      expect(result.data.on_fill!.take_profit).toBeDefined();
      expect(result.data.on_fill!.stop_loss).toBeDefined();
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

    it("returns twap order with linked_ids when present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/twap-order-123")
        .reply(200, {
          data: {
            ...mockTwapOrder,
            twap: {
              ...mockTwapOrder.twap,
              linked_ids: ["child-order-1", "child-order-2"],
            },
          },
        });

      const result = await client.getOrder("twap-order-123");

      expect(result.data.type).toBe("twap");
      expect(result.data.twap).toBeDefined();
      expect(result.data.twap!.type).toBe("market");
      expect(result.data.twap!.linked_ids).toEqual([
        "child-order-1",
        "child-order-2",
      ]);
    });

    it("returns twap limit order with price in twap details", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/twap-limit-123")
        .reply(200, {
          data: {
            ...mockTwapOrder,
            id: "twap-limit-123",
            twap: {
              ...mockTwapOrder.twap,
              type: "limit",
              price: "10.10",
              linked_ids: ["child-1", "child-2"],
            },
          },
        });

      const result = await client.getOrder("twap-limit-123");

      expect(result.data.twap!.type).toBe("limit");
      expect(result.data.twap!.price).toBe("10.10");
      expect(result.data.twap!.linked_ids).toEqual(["child-1", "child-2"]);
    });

    it("includes triggered_by with twap reason when present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/order-twap-slice")
        .reply(200, {
          data: {
            ...mockOrder,
            id: "order-twap-slice",
            triggered_by: {
              twap: {
                parent_id: "twap-parent-123",
                slice_index: 1,
              },
              reason: "twap",
            },
          },
        });

      const result = await client.getOrder("order-twap-slice");

      expect(result.data.triggered_by).toBeDefined();
      expect(result.data.triggered_by!.reason).toBe("twap");
      expect(result.data.triggered_by!.twap).toBeDefined();
      expect(result.data.triggered_by!.twap!.parent_id).toBe("twap-parent-123");
      expect(result.data.triggered_by!.twap!.slice_index).toBe(1);
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

    it("replaces order with timeInForce alongside price", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tif",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        price: "95000",
        timeInForce: "gtc",
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        price: "95000",
        time_in_force: "gtc",
      });
    });

    it("replaces order with only timeInForce", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tif-only",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        timeInForce: "ioc",
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        time_in_force: "ioc",
      });
    });

    it("replaces order with takeProfit trigger price", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-tp",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        takeProfit: { triggerPrice: "105000" },
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        take_profit: { trigger_price: "105000" },
      });
    });

    it("replaces order with stopLoss trigger price", async () => {
      const client = createTestClient();
      let capturedBody: unknown;
      nock(BASE_URL)
        .put("/api/1.0/orders/order-123", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          data: {
            venue_order_id: "order-sl",
            client_order_id: "client-new",
            state: "new",
          },
        });

      await client.replaceOrder("order-123", {
        clientOrderId: "client-new",
        stopLoss: { triggerPrice: "88000" },
      });

      expect(capturedBody).toEqual({
        client_order_id: "client-new",
        stop_loss: { trigger_price: "88000" },
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
