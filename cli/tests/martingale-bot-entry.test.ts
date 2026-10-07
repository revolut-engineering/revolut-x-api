import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import { saveMartingaleState } from "../src/db/martingale-store.js";
import {
  FULL_FILL,
  PARTIAL_FILL,
  REFERENCE_PRICE,
  limitBuyPrices,
  makeBot,
  makeClient,
  takeProfitOrders,
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

describe("martingale market entry", () => {
  it("anchors the safety orders and stop-loss to the average fill price", async () => {
    // given
    const client = makeClient([FULL_FILL]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    const state = bot._state!;
    expect(limitBuyPrices(client)).toEqual(["2500.74", "2475.73", "2450.97"]);
    expect(state.stopLossPrice).toBe("2323.92");
    expect(state.initialBuyPrice).toBe("2526");
    expect(state.levels[0].price).toBe("2526");
    expect(state.tradeLog[0].price).toBe("2526");
  });

  it("anchors to filled amount over filled quantity when the average fill price is missing", async () => {
    // given
    const client = makeClient([
      {
        ...FULL_FILL,
        average_fill_price: undefined,
        price: "2600",
        filled_quantity: "0.0264",
      },
    ]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    expect(bot._state!.initialBuyPrice).toBe("2525");
    expect(limitBuyPrices(client)[0]).toBe("2499.75");
  });

  it("stops without placing safety orders or a take-profit when the entry is only partially filled", async () => {
    // given
    const client = makeClient([PARTIAL_FILL]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    const state = bot._state!;
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(bot._running).toBe(false);
    expect(bot._lifecycle).toBe("stopped");
    expect(state.inPosition).toBe(true);
    expect(state.totalQty).toBe("0.009991");
    expect(state.totalCost).toBe("25.26");
    expect(state.tpOrderId).toBeNull();
    expect(state.levels.every((level) => level.buyOrderIds.length === 0)).toBe(
      true,
    );
    expect(state.stopLossPrice).toBe("2323.92");
    expect(saveMartingaleState).toHaveBeenCalledWith(state);
  });

  it("keeps waiting while a partially filled entry is still active", async () => {
    // given
    const client = makeClient([PARTIAL_FILL, FULL_FILL], ["market-1"]);
    const bot = makeBot(client);

    // when
    await bot._initNewCycle();

    // then
    expect(bot._running).toBe(true);
    expect(limitBuyPrices(client)).toHaveLength(3);
    expect(takeProfitOrders(client)).toHaveLength(1);
  });

  it("fails the entry immediately when the market order dies without a fill", async () => {
    // given
    const client = makeClient([
      { status: "cancelled", filled_quantity: "0", filled_amount: "0" },
    ]);
    const bot = makeBot(client);

    // when
    const init = bot._initNewCycle();

    // then
    await expect(init).rejects.toThrow(
      /Failed to place market entry.*cancelled/,
    );
    expect(limitBuyPrices(client)).toHaveLength(0);
  });

  it("anchors a new cycle after a take-profit to that cycle's own fill", async () => {
    // given
    const bot = makeBot(makeClient([FULL_FILL]));
    await bot._initNewCycle();
    bot._resetCycle();
    const client = makeClient([
      { ...FULL_FILL, average_fill_price: "2600", filled_amount: "66.66" },
    ]);
    bot._client = client;

    // when
    await bot._tick(new Decimal("2590"));

    // then
    expect(limitBuyPrices(client)).toEqual(["2574", "2548.26", "2522.77"]);
    expect(bot._state!.stopLossPrice).toBe("2392");
    expect(bot._state!.initialBuyPrice).toBe("2600");
  });

  it("stops a new cycle whose entry is only partially filled", async () => {
    // given
    const bot = makeBot(makeClient([FULL_FILL]));
    await bot._initNewCycle();
    bot._resetCycle();
    const client = makeClient([PARTIAL_FILL]);
    bot._client = client;

    // when
    await bot._tick(new Decimal(REFERENCE_PRICE));

    // then
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(takeProfitOrders(client)).toHaveLength(0);
    expect(bot._running).toBe(false);
    expect(bot._state!.inPosition).toBe(true);
  });
});
