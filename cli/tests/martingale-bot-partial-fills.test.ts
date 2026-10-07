import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import { NotFoundError, type OrderDetails } from "@revolut/revolut-x-api";
import {
  saveMartingaleState,
  type MartingaleState,
} from "../src/db/martingale-store.js";
import {
  FULL_FILL,
  PAIR_INFO,
  limitBuys,
  makeBot,
  makeClient,
  takeProfitOrders,
  type FakeClient,
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

const TICK_PRICE = new Decimal("2510");

function makerFill(
  status: string,
  filledQuantity: string,
  filledAmount: string,
  averageFillPrice?: string,
): Partial<OrderDetails> {
  return {
    status: status as OrderDetails["status"],
    filled_quantity: filledQuantity,
    filled_amount: filledAmount,
    average_fill_price: averageFillPrice,
    total_fee: "0",
    fee_currency: "USD",
  };
}

function savedSnapshot(): MartingaleState {
  const calls = vi.mocked(saveMartingaleState).mock.calls;
  return structuredClone(calls[calls.length - 1][0]);
}

function failingFor(
  client: FakeClient,
  orderId: string,
  error: Error,
): FakeClient {
  const answer = client.getOrder.getMockImplementation()!;
  client.getOrder.mockImplementation(async (id: string) => {
    if (id === orderId) throw error;
    return answer(id);
  });
  return client;
}

async function botInCycle() {
  const firstClient = makeClient([FULL_FILL]);
  const bot = makeBot(firstClient);
  await bot._initNewCycle();
  const state = bot._state!;
  const takeProfitPrice = takeProfitOrders(firstClient)[0].limit!.price;
  const takeProfitId = state.tpOrderId!;
  const safetyOrder1Id = state.levels[1].buyOrderIds[0];
  const allResting = [
    takeProfitId,
    ...state.levels.flatMap((level) => level.buyOrderIds),
  ];
  return { bot, takeProfitPrice, takeProfitId, safetyOrder1Id, allResting };
}

function exchangeWith(
  activeIds: string[],
  orderStates: Record<string, Partial<OrderDetails>>,
  marketPolls: Partial<OrderDetails>[] = [],
): FakeClient {
  return makeClient(marketPolls, activeIds, [], orderStates);
}

describe("martingale partly filled orders", () => {
  it("books a fully filled safety order and moves the take-profit as before", async () => {
    // given
    const { bot, takeProfitId, safetyOrder1Id, allResting } =
      await botInCycle();
    const client = exchangeWith(
      allResting.filter((id) => id !== safetyOrder1Id),
      { [safetyOrder1Id]: makerFill("filled", "0.0533", "133.29") },
    );
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    expect(state.levels[1].filled).toBe(true);
    expect(state.levels[1].buyOrderIds).toEqual([]);
    expect(state.safetyOrdersFilled).toBe(1);
    expect(state.totalQty).toBe("0.0796658");
    expect(state.totalCost).toBe("199.95");
    expect(client.cancelOrder).toHaveBeenCalledWith(takeProfitId);
    expect(takeProfitOrders(client)).toEqual([
      expect.objectContaining({
        limit: expect.objectContaining({ baseSize: "0.0796658" }),
      }),
    ]);
    expect(limitBuys(client)).toHaveLength(0);
    expect(notes).toHaveBeenCalledWith(
      expect.stringContaining("BUY filled @ $2500.74 | 0.0533 ETH"),
    );
  });

  it("books a safety order that ended partly filled and puts the remainder back on the book", async () => {
    // given
    const { bot, takeProfitId, safetyOrder1Id, allResting } =
      await botInCycle();
    const client = exchangeWith(
      allResting.filter((id) => id !== safetyOrder1Id),
      { [safetyOrder1Id]: makerFill("partially_filled", "0.02", "50.01") },
    );
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    const level = state.levels[1];
    expect(state.totalQty).toBe("0.0463658");
    expect(state.totalCost).toBe("116.67");
    expect(level.filled).toBe(false);
    expect(level.quoteSize).toBe("83.32");
    expect(state.safetyOrdersFilled).toBe(0);
    expect(limitBuys(client)).toEqual([
      expect.objectContaining({
        limit: expect.objectContaining({
          price: "2500.74",
          quoteSize: "83.32",
        }),
      }),
    ]);
    expect(level.buyOrderIds).toHaveLength(1);
    expect(level.buyOrderIds).not.toContain(safetyOrder1Id);
    expect(client.cancelOrder).toHaveBeenCalledWith(takeProfitId);
    expect(takeProfitOrders(client)).toEqual([
      expect.objectContaining({
        limit: expect.objectContaining({ baseSize: "0.0463658" }),
      }),
    ]);
    expect(state.tradeLog.at(-1)).toMatchObject({
      side: "buy",
      quantity: "0.02",
      reason: "safety",
    });
    expect(notes).toHaveBeenCalledWith(
      expect.stringContaining("BUY partly filled @ $2500.74 | 0.02 ETH"),
    );
  });

  it("closes the level when the unfilled remainder is below the exchange minimum", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    const client = exchangeWith(
      allResting.filter((id) => id !== safetyOrder1Id),
      {
        [safetyOrder1Id]: makerFill("partially_filled", "0.0531", "132.80"),
      },
    );
    bot._client = client;

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    expect(state.levels[1].filled).toBe(true);
    expect(state.levels[1].buyOrderIds).toEqual([]);
    expect(state.safetyOrdersFilled).toBe(1);
    expect(limitBuys(client)).toHaveLength(0);
    expect(takeProfitOrders(client)).toHaveLength(1);
  });

  it("leaves a partly filled safety order alone while it is still on the book", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    const client = exchangeWith(allResting, {
      [safetyOrder1Id]: makerFill("partially_filled", "0.02", "50.01"),
    });
    client.getActiveOrders.mockResolvedValueOnce({ data: [], metadata: {} });
    bot._client = client;

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    expect(state.totalQty).toBe("0.0263658");
    expect(state.levels[1].buyOrderIds).toEqual([safetyOrder1Id]);
    expect(state.levels[1].quoteSize).toBe("133.33");
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("books a take-profit that ended partly filled and places a new one for the rest", async () => {
    // given
    const { bot, takeProfitPrice, takeProfitId, allResting } =
      await botInCycle();
    const soldAmount = new Decimal("0.01").times(takeProfitPrice).toFixed(4);
    const client = exchangeWith(
      allResting.filter((id) => id !== takeProfitId),
      {
        [takeProfitId]: makerFill(
          "partially_filled",
          "0.01",
          soldAmount,
          takeProfitPrice,
        ),
      },
    );
    bot._client = client;

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    const releasedCost = new Decimal("66.66").times("0.01").div("0.0263658");
    expect(state.inPosition).toBe(true);
    expect(state.totalQty).toBe("0.0163658");
    expect(new Decimal(state.totalCost).toFixed(6)).toBe(
      new Decimal("66.66").minus(releasedCost).toFixed(6),
    );
    expect(new Decimal(state.stats.realizedPnl).toFixed(6)).toBe(
      new Decimal(soldAmount).minus(releasedCost).toFixed(6),
    );
    expect(state.stats.completedCycles).toBe(0);
    expect(state.tpOrderId).not.toBe(takeProfitId);
    expect(takeProfitOrders(client)).toEqual([
      expect.objectContaining({
        limit: expect.objectContaining({
          price: takeProfitPrice,
          baseSize: "0.0163658",
        }),
      }),
    ]);
    expect(state.tradeLog.at(-1)).toMatchObject({
      side: "sell",
      quantity: "0.01",
      reason: "tp",
    });
  });

  it("completes the cycle once a partly filled take-profit has sold everything", async () => {
    // given
    const { bot, takeProfitPrice, takeProfitId, allResting } =
      await botInCycle();
    const firstSale = new Decimal("0.01").times(takeProfitPrice).toFixed(4);
    const orderStates: Record<string, Partial<OrderDetails>> = {
      [takeProfitId]: makerFill(
        "partially_filled",
        "0.01",
        firstSale,
        takeProfitPrice,
      ),
    };
    const resting = allResting.filter((id) => id !== takeProfitId);
    const client = exchangeWith(resting, orderStates, [FULL_FILL]);
    bot._client = client;
    await bot._tick(TICK_PRICE);
    const secondTakeProfitId = bot._state!.tpOrderId!;
    const secondSale = new Decimal("0.0163658")
      .times(takeProfitPrice)
      .toFixed(4);
    orderStates[secondTakeProfitId] = makerFill(
      "filled",
      "0.0163658",
      secondSale,
      takeProfitPrice,
    );
    const notes = vi.spyOn(bot, "_notify");

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    const cycleProfit = new Decimal(firstSale).plus(secondSale).minus("66.66");
    expect(new Decimal(state.stats.realizedPnl).toFixed(2)).toBe(
      cycleProfit.toFixed(2),
    );
    expect(state.stats.completedCycles).toBe(1);
    expect(state.stats.winningCycles).toBe(1);
    expect(notes).toHaveBeenCalledWith(
      expect.stringContaining(`profit $${cycleProfit.toFixed(2)}`),
    );
    expect(client.placeOrder.mock.calls.some(([order]) => order.market)).toBe(
      true,
    );
  });

  it("books a partly filled order found on restart exactly once, even if the saved state is replayed", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    const partial = {
      [safetyOrder1Id]: makerFill("partially_filled", "0.02", "50.01"),
    };
    const restingAfter = allResting.filter((id) => id !== safetyOrder1Id);
    bot._client = exchangeWith(restingAfter, partial);
    await bot._reconcileAndInit(bot._state!);
    const saved = savedSnapshot();
    const replayClient = exchangeWith(restingAfter, partial);
    const replayed = makeBot(replayClient);

    // when
    await replayed._reconcileAndInit(saved);

    // then
    expect(saved.totalQty).toBe("0.0463658");
    expect(saved.levels[1].buyOrderIds).toEqual([]);
    expect(replayed._state!.totalQty).toBe("0.0463658");
    expect(replayed._state!.totalCost).toBe("116.67");
    expect(replayed._state!.levels[1].quoteSize).toBe("83.32");
    expect(replayClient.getOrder).not.toHaveBeenCalledWith(safetyOrder1Id);
    expect(replayClient.placeOrder).not.toHaveBeenCalled();
  });

  it("stops reconciling instead of guessing when the order book can't be read", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    const client = exchangeWith(
      allResting.filter((id) => id !== safetyOrder1Id),
      { [safetyOrder1Id]: makerFill("partially_filled", "0.02", "50.01") },
    );
    client.getActiveOrders.mockRejectedValue(new Error("rate limited"));
    bot._client = client;

    // when
    const reconcile = bot._reconcileAndInit(bot._state!);

    // then
    await expect(reconcile).rejects.toThrow(
      `Unable to reconcile safety order ${safetyOrder1Id}: rate limited`,
    );
    expect(bot._state!.totalQty).toBe("0.0263658");
    expect(bot._state!.levels[1].buyOrderIds).toEqual([safetyOrder1Id]);
  });

  it("stops reconciling when an order's state can't be read", async () => {
    // given
    const { bot, takeProfitId, allResting } = await botInCycle();
    bot._client = failingFor(
      exchangeWith(allResting, {}),
      takeProfitId,
      new Error("timeout"),
    );

    // when
    const reconcile = bot._reconcileAndInit(bot._state!);

    // then
    await expect(reconcile).rejects.toThrow(
      `Unable to reconcile take-profit order ${takeProfitId}: timeout`,
    );
    expect(bot._state!.tpOrderId).toBe(takeProfitId);
  });

  it("treats an order the exchange no longer knows as gone during reconciliation", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    bot._client = failingFor(
      exchangeWith(allResting, {}),
      safetyOrder1Id,
      new NotFoundError("order not found"),
    );

    // when
    await bot._reconcileAndInit(bot._state!);

    // then
    expect(bot._state!.levels[1].buyOrderIds).toEqual([]);
    expect(bot._state!.totalQty).toBe("0.0263658");
  });

  it("books a take-profit found partly filled on restart and replaces it on the next check", async () => {
    // given
    const { bot, takeProfitPrice, takeProfitId, allResting } =
      await botInCycle();
    const soldAmount = new Decimal("0.01").times(takeProfitPrice).toFixed(4);
    const resting = allResting.filter((id) => id !== takeProfitId);
    const client = exchangeWith(resting, {
      [takeProfitId]: makerFill(
        "partially_filled",
        "0.01",
        soldAmount,
        takeProfitPrice,
      ),
    });
    bot._client = client;
    await bot._reconcileAndInit(bot._state!);

    // when
    await bot._tick(TICK_PRICE);

    // then
    expect(bot._state!.totalQty).toBe("0.0163658");
    expect(takeProfitOrders(client)).toEqual([
      expect.objectContaining({
        limit: expect.objectContaining({
          price: takeProfitPrice,
          baseSize: "0.0163658",
        }),
      }),
    ]);
  });

  it("closes the cycle when what is left after a partial take-profit is below the exchange minimum", async () => {
    // given
    const { bot, takeProfitPrice, takeProfitId, allResting } =
      await botInCycle();
    const soldAmount = new Decimal("0.0263").times(takeProfitPrice).toFixed(4);
    const client = exchangeWith(
      allResting.filter((id) => id !== takeProfitId),
      {
        [takeProfitId]: makerFill(
          "partially_filled",
          "0.0263",
          soldAmount,
          takeProfitPrice,
        ),
      },
      [FULL_FILL],
    );
    bot._client = client;

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    expect(state.stats.completedCycles).toBe(1);
    expect(new Decimal(state.stats.realizedPnl).toFixed(4)).toBe(
      new Decimal(soldAmount).minus("66.66").toFixed(4),
    );
    expect(
      takeProfitOrders(client).some(
        (order) => order.limit?.baseSize === "0.0000658",
      ),
    ).toBe(false);
    expect(client.placeOrder.mock.calls.some(([order]) => order.market)).toBe(
      true,
    );
  });

  it("closes the level when the remainder rounds to zero on an exchange without a minimum", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    bot._pairInfo = {
      ...PAIR_INFO,
      min_order_size: "0",
      min_order_size_quote: "0",
    };
    const client = exchangeWith(
      allResting.filter((id) => id !== safetyOrder1Id),
      {
        [safetyOrder1Id]: makerFill("partially_filled", "0.0533", "133.325"),
      },
    );
    bot._client = client;

    // when
    await bot._tick(TICK_PRICE);

    // then
    expect(bot._state!.levels[1].filled).toBe(true);
    expect(limitBuys(client)).toHaveLength(0);
  });

  it("puts a safety order that closed without filling back on the book in full, as before", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    const client = exchangeWith(
      allResting.filter((id) => id !== safetyOrder1Id),
      { [safetyOrder1Id]: makerFill("cancelled", "0", "0") },
    );
    bot._client = client;

    // when
    await bot._tick(TICK_PRICE);

    // then
    expect(bot._state!.totalQty).toBe("0.0263658");
    expect(limitBuys(client)).toEqual([
      expect.objectContaining({
        limit: expect.objectContaining({
          price: "2500.74",
          quoteSize: "133.33",
        }),
      }),
    ]);
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(takeProfitOrders(client)).toHaveLength(0);
  });

  it("books a partly filled safety order whose fee was taken in coins", async () => {
    // given
    const { bot, safetyOrder1Id, allResting } = await botInCycle();
    const client = exchangeWith(
      allResting.filter((id) => id !== safetyOrder1Id),
      {
        [safetyOrder1Id]: {
          ...makerFill("partially_filled", "0.02", "50.01"),
          total_fee: "0.000018",
          fee_currency: "ETH",
        },
      },
    );
    bot._client = client;

    // when
    await bot._tick(TICK_PRICE);

    // then
    expect(bot._state!.totalQty).toBe("0.0463478");
    expect(bot._state!.totalCost).toBe("116.67");
    expect(bot._state!.levels[1].quoteSize).toBe("83.32");
  });

  it("completes a cycle when the take-profit fills completely, as before", async () => {
    // given
    const { bot, takeProfitPrice, takeProfitId, allResting } =
      await botInCycle();
    const sale = new Decimal("0.0263658").times(takeProfitPrice).toFixed(4);
    const client = exchangeWith(
      allResting.filter((id) => id !== takeProfitId),
      {
        [takeProfitId]: makerFill("filled", "0.0263658", sale, takeProfitPrice),
      },
      [FULL_FILL],
    );
    bot._client = client;
    const notes = vi.spyOn(bot, "_notify");

    // when
    await bot._tick(TICK_PRICE);

    // then
    const state = bot._state!;
    const profit = new Decimal(sale).minus("66.66");
    expect(state.stats.realizedPnl).toBe(profit.toString());
    expect(state.stats.completedCycles).toBe(1);
    expect(state.stats.winningCycles).toBe(1);
    expect(state.tradeLog.find((trade) => trade.reason === "tp")).toMatchObject(
      {
        price: takeProfitPrice,
        quantity: "0.0263658",
        profit: profit.toFixed(2),
      },
    );
    expect(notes).toHaveBeenCalledWith(
      `Martingale ETH-USD: TAKE PROFIT @ $${takeProfitPrice} | profit $${profit.toFixed(2)} | total P&L: $${profit.toFixed(2)}`,
    );
  });
});
