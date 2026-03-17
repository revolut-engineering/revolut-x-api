import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Order } from "revolutx-api";

const mockGetActiveOrders = vi.fn();
const mockGetHistoricalOrders = vi.fn();

vi.mock("../src/util/client.js", () => ({
  getClient: () => ({
    getActiveOrders: mockGetActiveOrders,
    getHistoricalOrders: mockGetHistoricalOrders,
  }),
}));

import { createProgram } from "../src/index.js";

function runCommand(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => {
        output += a.join(" ") + "\n";
      });
    const program = createProgram();
    program.exitOverride();
    program.parseAsync(["node", "revx", ...args]).then(() => {
      spy.mockRestore();
      resolve(output);
    });
  });
}

const MOCK_ORDERS: { data: Order[] } = {
  data: [
    {
      id: "order-1",
      client_order_id: "c-1",
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      quantity: "0.001",
      filled_quantity: "0",
      leaves_quantity: "0.001",
      price: "90000",
      status: "new",
      time_in_force: "gtc",
      execution_instructions: [],
      created_date: 1700000000000,
      updated_date: 1700000000000,
    },
  ],
};

describe("order list", () => {
  beforeEach(() => {
    mockGetActiveOrders.mockResolvedValue(MOCK_ORDERS);
  });

  it("passes order-states array", async () => {
    await runCommand([
      "order",
      "list",
      "--order-states",
      "pending_new,new",
      "--json",
    ]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({ orderStates: ["pending_new", "new"] }),
    );
  });

  it("passes order-types array", async () => {
    await runCommand([
      "order",
      "list",
      "--order-types",
      "limit,conditional",
      "--json",
    ]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({ orderTypes: ["limit", "conditional"] }),
    );
  });

  it("passes symbols array when --symbols is given", async () => {
    await runCommand([
      "order",
      "list",
      "--symbols",
      "BTC-USD,ETH-USD",
      "--json",
    ]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ["BTC-USD", "ETH-USD"] }),
    );
  });
});

describe("order history", () => {
  beforeEach(() => {
    mockGetHistoricalOrders.mockResolvedValue(MOCK_ORDERS);
  });

  it("passes order-states array", async () => {
    await runCommand([
      "order",
      "history",
      "--order-states",
      "filled,cancelled",
      "--json",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({ orderStates: ["filled", "cancelled"] }),
    );
  });

  it("passes order-types array", async () => {
    await runCommand([
      "order",
      "history",
      "--order-types",
      "market,limit",
      "--json",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({ orderTypes: ["market", "limit"] }),
    );
  });

  it("passes symbols array when --symbols is given", async () => {
    await runCommand([
      "order",
      "history",
      "--symbols",
      "BTC-USD,ETH-USD",
      "--json",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ["BTC-USD", "ETH-USD"] }),
    );
  });
});
