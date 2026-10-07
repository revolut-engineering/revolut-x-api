import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import type { OrderDetails } from "@revolut/revolut-x-api";
import { saveMartingaleState } from "../src/db/martingale-store.js";
import {
  FULL_FILL,
  makeBot,
  makeClient,
  marketSells,
} from "./support/martingale-harness.js";

vi.mock("../src/db/martingale-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/martingale-store.js")>()),
  saveMartingaleState: vi.fn(),
  deleteMartingaleState: vi.fn(),
}));

vi.mock("../src/db/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/store.js")>()),
  loadConnections: () => [],
}));

const STOP_LOSS_TRIGGER = new Decimal("2300");

const FULL_SELL: Partial<OrderDetails> = {
  status: "filled",
  filled_quantity: "0.08",
  filled_amount: "184",
  total_fee: "0",
  fee_currency: "USD",
};

const PARTIAL_SELL: Partial<OrderDetails> = {
  status: "partially_filled",
  filled_quantity: "0.048",
  filled_amount: "110.4",
  total_fee: "0",
  fee_currency: "USD",
};

const REMAINDER_SELL: Partial<OrderDetails> = {
  status: "filled",
  filled_quantity: "0.032",
  filled_amount: "73.6",
  total_fee: "0",
  fee_currency: "USD",
};

function connectionLost(): Error {
  return new Error("socket hang up");
}

async function botHoldingPosition() {
  const bot = makeBot(makeClient([FULL_FILL]));
  await bot._initNewCycle();
  const state = bot._state!;
  state.totalQty = "0.08";
  state.totalCost = "200";
  state.avgEntryPrice = "2500";
  return bot;
}

async function settle<T>(work: Promise<T>): Promise<T> {
  let finished = false;
  const tracked = work.finally(() => {
    finished = true;
  });
  while (!finished) await vi.advanceTimersByTimeAsync(500);
  return tracked;
}

describe("martingale stop-loss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(saveMartingaleState).mockReset();
  });

  it("completes a stop-loss that fills on the first attempt", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient([
      { ...FULL_SELL, total_fee: "0.17", fee_currency: "USD" },
    ]);
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const state = bot._state!;
    expect(marketSells(client)).toEqual([
      expect.objectContaining({ market: { baseSize: "0.08" } }),
    ]);
    expect(state.inPosition).toBe(false);
    expect(state.totalQty).toBe("0");
    expect(state.totalCost).toBe("0");
    expect(state.stats.realizedPnl).toBe("-16.17");
    expect(state.stats.completedCycles).toBe(1);
    expect(state.stats.totalSells).toBe(1);
    expect(state.tradeLog.at(-1)).toMatchObject({
      side: "sell",
      price: "2300",
      quantity: "0.08",
      reason: "sl",
      profit: "-16.17",
      fee: "0.17",
    });
    expect(notes).toHaveBeenCalledWith(
      "Martingale Bot ETH-USD: STOP LOSS triggered at $2300.00. Sold 0.08 base. Realized P&L: $-16.17",
    );
    expect(bot._running).toBe(false);
    expect(bot._lifecycle).toBe("stopped");
  });

  it("keeps the whole position when every stop-loss sell fails", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient(
      [],
      [],
      [connectionLost(), connectionLost(), connectionLost()],
    );
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");
    const alerts = vi.spyOn(bot, "_notifyAndWait");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const state = bot._state!;
    expect(marketSells(client)).toHaveLength(3);
    expect(state.inPosition).toBe(true);
    expect(state.totalQty).toBe("0.08");
    expect(state.totalCost).toBe("200");
    expect(state.stats.realizedPnl).toBe("0");
    expect(state.stats.completedCycles).toBe(0);
    expect(state.stopLossClientOrderId).toBeDefined();
    expect(alerts).toHaveBeenCalledWith(
      expect.stringContaining("Sold 0 of 0.08 ETH; still holding 0.08 ETH"),
    );
    expect(notes).not.toHaveBeenCalledWith(
      expect.stringContaining("Sold 0.08 base"),
    );
    expect(bot._running).toBe(false);
    expect(bot._lifecycle).toBe("stopped");
  });

  it("books a partial sell and sells only the remainder on the next attempt", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient([PARTIAL_SELL, REMAINDER_SELL]);
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const state = bot._state!;
    expect(marketSells(client).map((order) => order.market?.baseSize)).toEqual([
      "0.08",
      "0.032",
    ]);
    expect(new Decimal(state.stats.realizedPnl).toFixed(2)).toBe("-16.00");
    expect(state.stats.completedCycles).toBe(1);
    expect(state.stats.totalSells).toBe(2);
    expect(state.inPosition).toBe(false);
    expect(state.stopLossClientOrderId).toBeUndefined();
    expect(state.tradeLog.slice(-2)).toEqual([
      expect.objectContaining({ quantity: "0.048", profit: "-9.60" }),
      expect.objectContaining({ quantity: "0.032", profit: "-6.40" }),
    ]);
    expect(notes).toHaveBeenCalledWith(
      "Martingale Bot ETH-USD: STOP LOSS triggered at $2300.00. Sold 0.08 base. Realized P&L: $-16.00",
    );
  });

  it("keeps the unsold remainder when later stop-loss sells fail", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient(
      [PARTIAL_SELL],
      [],
      [null, connectionLost(), connectionLost()],
    );
    bot._client = client;
    const alerts = vi.spyOn(bot, "_notifyAndWait");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const state = bot._state!;
    expect(state.inPosition).toBe(true);
    expect(state.totalQty).toBe("0.032");
    expect(state.totalCost).toBe("80");
    expect(new Decimal(state.stats.realizedPnl).toFixed(2)).toBe("-9.60");
    expect(state.stats.completedCycles).toBe(0);
    expect(state.stopLossClientOrderId).toBeDefined();
    expect(state.tradeLog.at(-1)).toMatchObject({
      quantity: "0.048",
      profit: "-9.60",
    });
    expect(alerts).toHaveBeenCalledWith(
      expect.stringContaining(
        "Sold 0.048 of 0.08 ETH; still holding 0.032 ETH",
      ),
    );
  });

  it("saves the pending stop-loss before every sell attempt", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient(
      [PARTIAL_SELL],
      [],
      [null, connectionLost(), connectionLost()],
    );
    bot._client = client;
    const events: string[] = [];
    vi.mocked(saveMartingaleState).mockImplementation((saved) => {
      events.push(`save:${saved.stopLossClientOrderId ?? "none"}`);
    });
    const place = client.placeOrder.getMockImplementation()!;
    client.placeOrder.mockImplementation(async (order) => {
      events.push(`place:${order.clientOrderId}`);
      return place(order);
    });

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const placements = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.startsWith("place:"));
    expect(placements).toHaveLength(3);
    for (const { event, index } of placements) {
      const id = event.slice("place:".length);
      expect(events[index - 1]).toBe(`save:${id}`);
    }
  });

  it("reuses the order id when waiting for the fill times out", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient([
      { status: "new", filled_quantity: "0", filled_amount: "0" },
    ]);
    bot._client = client;

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const ids = marketSells(client).map((order) => order.clientOrderId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(bot._state!.totalQty).toBe("0.08");
    expect(bot._state!.stopLossClientOrderId).toBe(ids[0]);
  });

  it("uses a new order id after a sell is rejected outright", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient([
      { status: "rejected", filled_quantity: "0", filled_amount: "0" },
      FULL_SELL,
    ]);
    bot._client = client;

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const ids = marketSells(client).map((order) => order.clientOrderId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(bot._state!.inPosition).toBe(false);
  });

  it("simulates a dry-run stop-loss exactly as before", async () => {
    // given
    const bot = await botHoldingPosition();
    bot._config.dryRun = true;
    const client = makeClient([]);
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const state = bot._state!;
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(state.stats.realizedPnl).toBe("-16.17");
    expect(state.stats.completedCycles).toBe(1);
    expect(notes).toHaveBeenCalledWith(
      "Martingale Bot ETH-USD: STOP LOSS triggered at $2300.00. Sold 0.08 base. Realized P&L: $-16.17",
    );
  });

  it("books a stop-loss whose fee was taken in coins", async () => {
    // given
    const bot = await botHoldingPosition();
    bot._client = makeClient([
      {
        status: "filled",
        filled_quantity: "0.0799",
        filled_amount: "183.77",
        total_fee: "0.0001",
        fee_currency: "ETH",
      },
    ]);

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const state = bot._state!;
    expect(state.inPosition).toBe(false);
    expect(state.stats.realizedPnl).toBe("-16.23");
    expect(state.stats.completedCycles).toBe(1);
  });

  it("logs the price the stop-loss actually sold at", async () => {
    // given
    const bot = await botHoldingPosition();
    bot._client = makeClient([{ ...FULL_SELL, filled_amount: "183.2" }]);
    const notes = vi.spyOn(bot, "_notify");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    expect(bot._state!.tradeLog.at(-1)).toMatchObject({
      price: "2290",
      reason: "sl",
    });
    expect(notes).toHaveBeenCalledWith(
      expect.stringContaining(
        "STOP LOSS triggered at $2300.00. Sold 0.08 base.",
      ),
    );
  });

  it("books the loss of a position too small to sell at the stop-loss", async () => {
    // given
    const bot = await botHoldingPosition();
    const state = bot._state!;
    state.totalQty = "0.0004";
    state.totalCost = "1";
    const client = makeClient([]);
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    expect(marketSells(client)).toHaveLength(0);
    expect(state.stats.realizedPnl).toBe("-1");
    expect(state.stats.completedCycles).toBe(1);
    expect(state.inPosition).toBe(false);
    expect(notes).toHaveBeenCalledWith(
      expect.stringContaining(
        "Sold 0 base. 0.0004 base below the exchange minimum stays in the wallet.",
      ),
    );
  });

  it("completes the stop-loss when what is left is below the exchange minimum", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient([
      {
        status: "partially_filled",
        filled_quantity: "0.07995",
        filled_amount: "183.885",
        total_fee: "0",
        fee_currency: "USD",
      },
    ]);
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const state = bot._state!;
    expect(marketSells(client)).toHaveLength(1);
    expect(state.inPosition).toBe(false);
    expect(state.stats.completedCycles).toBe(1);
    expect(state.stats.realizedPnl).toBe("-16.115");
    expect(state.stopLossClientOrderId).toBeUndefined();
    expect(notes).toHaveBeenCalledWith(
      expect.stringContaining(
        "Sold 0.07995 base. 0.00005 base below the exchange minimum stays in the wallet.",
      ),
    );
  });

  it("retries a pending stop-loss first on restart even after the price recovered", async () => {
    // given
    const bot = await botHoldingPosition();
    const state = bot._state!;
    for (const level of state.levels) level.buyOrderIds = [];
    state.tpOrderId = null;
    state.stopLossClientOrderId = "pending-stop-loss";
    const client = makeClient([FULL_SELL]);
    bot._client = client;

    // when
    await settle(bot._reconcileAndInit(state));

    // then
    expect(client.placeOrder.mock.calls.map(([order]) => order)).toEqual([
      expect.objectContaining({
        side: "sell",
        clientOrderId: "pending-stop-loss",
        market: { baseSize: "0.08" },
      }),
    ]);
    expect(bot._state!.inPosition).toBe(false);
    expect(bot._running).toBe(false);
  });

  it("reuses the order id after an unknown outcome and replaces it after a known partial fill", async () => {
    // given
    const bot = await botHoldingPosition();
    const client = makeClient(
      [PARTIAL_SELL, REMAINDER_SELL],
      [],
      [connectionLost(), null, null],
    );
    bot._client = client;

    // when
    await settle(bot._tick(STOP_LOSS_TRIGGER));

    // then
    const ids = marketSells(client).map((order) => order.clientOrderId);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(bot._state!.inPosition).toBe(false);
  });

  it("resumes a saved position without a pending stop-loss exactly as before", async () => {
    // given
    const bot = await botHoldingPosition();
    const state = bot._state!;
    for (const level of state.levels) level.buyOrderIds = [];
    state.tpOrderId = null;
    const client = makeClient([FULL_SELL]);
    bot._client = client;

    // when
    await settle(bot._reconcileAndInit(state));

    // then
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(bot._state!.inPosition).toBe(true);
    expect(bot._running).toBe(true);
  });
});
