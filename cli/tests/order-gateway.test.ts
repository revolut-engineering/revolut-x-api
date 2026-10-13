import { describe, expect, it, vi } from "vitest";
import {
  InsecureKeyPermissionsError,
  NotFoundError,
} from "@revolut/revolut-x-api";
import type { OrderDetails } from "@revolut/revolut-x-api";
import {
  awaitTerminal,
  awaitTerminalOrNull,
  cancelUntilClosed,
  outsideChange,
  type OrderGateway,
} from "../src/engine/order-gateway.js";

function order(overrides: Partial<OrderDetails> = {}): OrderDetails {
  return {
    id: "order-1",
    client_order_id: "client-1",
    symbol: "BTC/USD",
    side: "buy",
    type: "limit",
    quantity: "0.1",
    filled_quantity: "0",
    leaves_quantity: "0.1",
    price: "99",
    status: "new",
    time_in_force: "gtc",
    execution_instructions: ["post_only"],
    created_date: 1,
    updated_date: 1,
    ...overrides,
  };
}

function fakeGateway(
  reads: Array<OrderDetails | Error>,
  options: { cancelError?: Error; active?: boolean[] } = {},
) {
  let clock = 0;
  const pending = [...reads];
  const activity = [...(options.active ?? [])];
  const gateway: OrderGateway = {
    cancel: vi.fn(async () => {
      if (options.cancelError) throw options.cancelError;
    }),
    getOrder: vi.fn(async () => {
      const next = pending.length > 1 ? pending.shift()! : pending[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    isActive: vi.fn(async () =>
      activity.length > 1 ? activity.shift()! : (activity[0] ?? false),
    ),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return gateway;
}

describe("cancelUntilClosed", () => {
  it("returns an order that traded before the cancel instead of throwing", async () => {
    // given
    const filled = order({ status: "filled", filled_quantity: "0.1" });
    const gateway = fakeGateway([filled]);

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: filled });
    expect(gateway.cancel).toHaveBeenCalledWith("order-1");
  });

  it("confirms the close even when the cancel call itself fails", async () => {
    // given
    const cancelled = order({ status: "cancelled" });
    const gateway = fakeGateway([cancelled], {
      cancelError: new Error("order is not active"),
    });

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: cancelled });
  });

  it("waits out a short not-found answer before reading the final state", async () => {
    // given
    const cancelled = order({ status: "cancelled" });
    const gateway = fakeGateway([
      new NotFoundError("Order not found"),
      cancelled,
    ]);

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: cancelled });
  });

  it("reports an order that stays not-found for the whole window as closed with no details", async () => {
    // given
    const gateway = fakeGateway([new NotFoundError("Order not found")]);

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: null });
  });

  it("sends the cancel again once an order it couldn't find shows up open", async () => {
    // given
    const cancelled = order({ status: "cancelled" });
    const gateway = fakeGateway([
      new NotFoundError("Order not found"),
      order({ status: "new" }),
      cancelled,
    ]);
    vi.mocked(gateway.cancel).mockRejectedValueOnce(
      new NotFoundError("Active order not found"),
    );

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: cancelled });
    expect(gateway.cancel).toHaveBeenCalledTimes(2);
  });

  it("doesn't cancel again when the order it couldn't find shows up already closed", async () => {
    // given
    const cancelled = order({ status: "cancelled" });
    const gateway = fakeGateway([
      new NotFoundError("Order not found"),
      cancelled,
    ]);
    vi.mocked(gateway.cancel).mockRejectedValueOnce(
      new NotFoundError("Active order not found"),
    );

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: cancelled });
    expect(gateway.cancel).toHaveBeenCalledTimes(1);
  });

  it("sends the cancel again after any failed first cancel once the order shows up open", async () => {
    // given
    const cancelled = order({ status: "cancelled" });
    const gateway = fakeGateway([order({ status: "new" }), cancelled]);
    vi.mocked(gateway.cancel).mockRejectedValueOnce(new Error("timeout"));

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: cancelled });
    expect(gateway.cancel).toHaveBeenCalledTimes(2);
  });

  it("sends the cancel only once when the first one was accepted", async () => {
    // given
    const cancelled = order({ status: "cancelled" });
    const gateway = fakeGateway([order({ status: "new" }), cancelled]);

    // when
    await cancelUntilClosed(gateway, "order-1");

    // then
    expect(gateway.cancel).toHaveBeenCalledTimes(1);
  });

  it("reports an order that never closes as not closed", async () => {
    // given
    const gateway = fakeGateway([order({ status: "new" })]);

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: false });
  });

  it("keeps waiting while a partly filled order is still on the book", async () => {
    // given
    const partial = order({
      status: "partially_filled",
      filled_quantity: "0.04",
    });
    const gateway = fakeGateway([partial], { active: [true, false] });

    // when
    const outcome = await cancelUntilClosed(gateway, "order-1");

    // then
    expect(outcome).toEqual({ closed: true, order: partial });
    expect(gateway.isActive).toHaveBeenCalledTimes(2);
  });

  it("rethrows unsafe key permissions", async () => {
    // given
    const gateway = fakeGateway([order({ status: "cancelled" })], {
      cancelError: new InsecureKeyPermissionsError("unsafe", "/key"),
    });

    // when
    const outcome = cancelUntilClosed(gateway, "order-1");

    // then
    await expect(outcome).rejects.toBeInstanceOf(InsecureKeyPermissionsError);
  });
});

describe("awaitTerminal", () => {
  it("returns the order once it is filled", async () => {
    // given
    const filled = order({ status: "filled", filled_quantity: "0.1" });
    const gateway = fakeGateway([order({ status: "new" }), filled]);

    // when
    const result = await awaitTerminal(gateway, "order-1");

    // then
    expect(result).toEqual(filled);
  });

  it("names the order in a neutral timeout message", async () => {
    // given
    const gateway = fakeGateway([order({ status: "new" })]);

    // when
    const result = awaitTerminal(gateway, "order-1", 2_000);

    // then
    await expect(result).rejects.toThrow(
      "Order order-1 did not reach a final state within 2s",
    );
  });
});

describe("awaitTerminalOrNull", () => {
  it("waits out the not-found answer right after placement and returns the rejected order", async () => {
    // given
    const rejected = order({ status: "rejected" });
    const gateway = fakeGateway([
      new NotFoundError("Order with ID 'order-1' not found."),
      rejected,
    ]);

    // when
    const result = await awaitTerminalOrNull(gateway, "order-1", 5_000);

    // then
    expect(result).toEqual(rejected);
  });

  it("returns null when the order is not final within the window", async () => {
    // given
    const gateway = fakeGateway([
      new NotFoundError("Order with ID 'order-1' not found."),
    ]);

    // when
    const result = await awaitTerminalOrNull(gateway, "order-1", 5_000);

    // then
    expect(result).toBeNull();
  });

  it("rethrows unsafe key permissions", async () => {
    // given
    const gateway = fakeGateway([
      new InsecureKeyPermissionsError("loose", "/tmp/key.pem"),
    ]);

    // when
    const result = awaitTerminalOrNull(gateway, "order-1", 5_000);

    // then
    await expect(result).rejects.toBeInstanceOf(InsecureKeyPermissionsError);
  });
});

describe("outsideChange", () => {
  it.each([
    ["a plain cancel", { status: "cancelled" }, "cancelled"],
    [
      "a cancel the exchange made for a replace",
      { status: "cancelled", reject_reason: "replaced" },
      "replaced",
    ],
    ["a replaced status", { status: "replaced" }, "replaced"],
    [
      "a replace after a partial fill",
      { status: "partially_filled", reject_reason: "replaced" },
      "replaced",
    ],
    ["a plain partial fill", { status: "partially_filled" }, null],
    ["a rejection", { status: "rejected" }, null],
    [
      "a rejection that names a replace",
      { status: "rejected", reject_reason: "replaced" },
      null,
    ],
    ["a fill", { status: "filled" }, null],
    ["an open order", { status: "new" }, null],
  ] as const)("calls %s %s", (_, fields, change) => {
    expect(outsideChange(order(fields))).toBe(change);
  });
});
