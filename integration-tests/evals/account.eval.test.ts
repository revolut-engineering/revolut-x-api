import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");

const BALANCES = [
  { currency: "BTC", available: "1.5", reserved: "0.1", total: "1.6" },
  { currency: "ETH", available: "8", reserved: "0", total: "8" },
  { currency: "USD", available: "12000", reserved: "0", total: "12000" },
  { currency: "EUR", available: "3500", reserved: "0", total: "3500" },
];

const FILLED_ORDER = {
  id: "f2b9c-447e",
  client_order_id: "cli-f2b9c",
  symbol: "BTC-USD",
  side: "buy",
  type: "limit",
  quantity: "0.333",
  filled_quantity: "0.333",
  filled_amount: "30000",
  leaves_quantity: "0",
  price: "90000",
  average_fill_price: "90090.09",
  status: "filled",
  time_in_force: "gtc",
  execution_instructions: ["allow_taker"],
  created_date: Date.now() - 3 * 86_400_000,
  updated_date: Date.now() - 3 * 86_400_000,
};

const ACTIVE_ORDERS = [
  {
    id: "ord-active-1",
    client_order_id: "cli-active-1",
    symbol: "BTC-USD",
    side: "buy",
    type: "limit",
    quantity: "0.5",
    filled_quantity: "0",
    leaves_quantity: "0.5",
    price: "88000",
    status: "new",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: Date.now() - 86_400_000,
    updated_date: Date.now() - 86_400_000,
  },
  {
    id: "ord-active-2",
    client_order_id: "cli-active-2",
    symbol: "ETH-EUR",
    side: "sell",
    type: "limit",
    quantity: "5",
    filled_quantity: "2",
    filled_amount: "8000",
    leaves_quantity: "3",
    price: "4000",
    average_fill_price: "4000",
    status: "partially_filled",
    time_in_force: "gtc",
    execution_instructions: ["allow_taker"],
    created_date: Date.now() - 2 * 86_400_000,
    updated_date: Date.now() - 86_400_000,
  },
];

describe("account state & single-record lookups", () => {
  defineEval({
    name: "account-balances-multi-currency",
    description:
      "Casual phrasing 'what do I have on revolut x' → get_balances once; amounts labelled with currencies.",
    prompt: "what do I have on revolut x",
    setup: () => {
      revolutXMockState.getBalances.mockResolvedValueOnce(BALANCES);
    },
    assertions: [
      a.callsTool("get_balances"),
      a.callsToolNTimes("get_balances", 1),
      a.doesNotCallTool("get_historical_orders"),
      a.doesNotCallTool("get_tickers"),
      a.finalTextContainsAll(["BTC", "ETH", "USD", "EUR"]),
      a.judge({
        name: "currency labels next to amounts; no cross-currency fabrication",
        criterion:
          "The answer reports the four balances (BTC, ETH, USD, EUR) with the currency label adjacent to each numeric amount. " +
          "Note: each balance object contains available, reserved, staked, and total fields — reporting any of these IS faithful to the tool output, not fabrication. " +
          "The only thing that counts as fabrication here is INVENTING a single USD-equivalent total across currencies, a portfolio percentage breakdown, or applying a conversion rate not present in the tool result.",
        rubric:
          "1.0 = four balances reported with adjacent currency labels, no invented cross-currency totals. " +
          "0.7 = correct balances but a label is detached. " +
          "0.4 = invents a cross-currency total or conversion rate. " +
          "0.0 = wrong numbers entirely.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "single-order-lookup",
    description:
      "Natural-language order-ID extraction → get_order_by_id, not get_historical_orders.",
    prompt: "look up order f2b9c-447e for me, what happened with it",
    setup: () => {
      revolutXMockState.getOrder.mockResolvedValueOnce({ data: FILLED_ORDER });
    },
    assertions: [
      a.callsTool("get_order_by_id"),
      a.callsToolWithArgs("get_order_by_id", { order_id: "f2b9c-447e" }),
      a.doesNotCallTool("get_historical_orders"),
      a.doesNotCallTool("get_client_trades"),
      a.finalTextContainsAll(["filled", "BTC-USD"]),
      a.judge({
        name: "reports the order's filled status, quantity, and average fill price",
        criterion:
          "The answer reports the order's status as filled, the filled quantity (0.333 BTC), and the average fill price (around 90,090 USD). " +
          "Note: any timestamp, total cost (filled_amount × 1 = $30,000), and trailing fields like 'allow_taker' ARE in the tool output, so reporting them is not fabrication — only invented fees / counterparties / related orders would count.",
        rubric:
          "1.0 = status + qty + avg price all reported faithfully. " +
          "0.7 = correct but one of the three vague. " +
          "0.4 = one of status/qty/price wrong or missing. " +
          "0.0 = multiple errors or unrelated answer.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "open-orders-non-empty",
    description:
      "Casual phrasing for open orders → get_active_orders; preserves partial-fill nuance.",
    prompt: "what open / working orders do I have right now on revolut x?",
    setup: () => {
      revolutXMockState.getActiveOrders.mockResolvedValue({
        data: ACTIVE_ORDERS,
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_active_orders"),
      a.doesNotCallTool("get_historical_orders"),
      a.finalTextContainsAll(["BTC-USD", "ETH-EUR"]),
      a.judge({
        name: "mentions partial-fill status; reports per-order remaining quantity",
        criterion:
          "The answer mentions both active orders (BTC-USD buy at 88000, ETH-EUR sell at 4000) AND explicitly flags that the ETH-EUR order is partially filled (2 out of 5 filled, 3 remaining). " +
          "It does not silently aggregate the orders or drop the partial-fill state.",
        rubric:
          "1.0 = both orders named, partial-fill state explicit, remaining quantities clear. " +
          "0.7 = both orders named, partial-fill mentioned but vague on quantities. " +
          "0.4 = one order missing or partial fill not mentioned. " +
          "0.0 = wrong information or significant fabrication.",
        threshold: 0.7,
      }),
    ],
  });
});
