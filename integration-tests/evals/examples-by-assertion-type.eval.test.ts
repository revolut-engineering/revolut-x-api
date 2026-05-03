import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");
const { revolutXMockState } = await import("../src/harness/revolut-x-mock.js");
const {
  mockBalance,
  mockUsdBalance,
  mockCurrency,
  mockUsdCurrency,
  mockCurrencyPair,
  mockTicker,
} = await import("../src/fixtures/index.js");

describe("examples — every assertion type", () => {
  defineEval({
    name: "ex1-predicate-basics-balances",
    description:
      "Predicate basics: callsTool, callsToolNTimes, doesNotCallTool, endsTurn, finalTextContainsAll, withinTokenBudget",
    prompt: "What's in my Revolut X account right now?",
    setup: () => {
      revolutXMockState.getBalances.mockResolvedValueOnce([
        mockBalance,
        mockUsdBalance,
      ]);
    },
    assertions: [
      a.callsTool("get_balances"),
      a.callsToolNTimes("get_balances", 1),
      a.doesNotCallTool("get_tickers"),
      a.endsTurn(),
      a.finalTextContainsAll(["BTC", "USD"]),
      a.withinTokenBudget(2000),
    ],
  });

  defineEval({
    name: "ex2-args-validation-historical-orders",
    description:
      "Args + custom predicate: callsToolWithArgs, finalTextMatches, withinLatency, raw { name, check }",
    prompt:
      "Show me my filled BTC-USD orders from the last 7 days. Cap at 50 results.",
    setup: () => {
      revolutXMockState.getHistoricalOrders.mockResolvedValueOnce({
        data: [],
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_historical_orders"),
      a.callsToolWithArgs("get_historical_orders", {
        symbols: ["BTC-USD"],
        order_states: ["filled"],
      }),
      a.finalTextMatches(/no.*(orders|results|matches)|empty|none/i),
      a.withinLatency(60_000),
      {
        name: "totalLimit ≤ 50",
        check: ({ toolCalls }) => {
          const call = toolCalls.find(
            (c) => c.name === "get_historical_orders",
          );
          if (!call) return false;
          const limit = (call.args as { totalLimit?: number }).totalLimit;
          return limit !== undefined && limit > 0 && limit <= 50;
        },
      },
    ],
  });

  defineEval({
    name: "ex3-ordered-market-overview",
    description:
      "Ordering: callsInOrder (subsequence). Reference: callsExactly (multiset), callsExactlyInOrder (strict)",
    prompt:
      "Give me an overview of the markets available on Revolut X and current prices.",
    setup: () => {
      revolutXMockState.getCurrencyPairs.mockResolvedValueOnce({
        "BTC/USD": mockCurrencyPair,
      });
      revolutXMockState.getCurrencies.mockResolvedValueOnce({
        BTC: mockCurrency,
        USD: mockUsdCurrency,
      });
      revolutXMockState.getTickers.mockResolvedValueOnce({
        data: [mockTicker],
        metadata: { timestamp: 1700000000000 },
      });
    },
    assertions: [
      a.callsTool("get_tickers"),
      a.callsInOrder(["get_currency_pairs", "get_tickers"]),
      a.finalTextContainsAll(["BTC"]),
    ],
  });

  defineEval({
    name: "ex4-judge-quality-snapshot",
    description:
      "LLM-as-judge: a.judge with explicit rubric + threshold (uses EVAL_JUDGE_MODEL, default Sonnet)",
    prompt:
      "Give me a quick snapshot: my current balances and the current BTC-USD price.",
    setup: () => {
      revolutXMockState.getBalances.mockResolvedValueOnce([
        mockBalance,
        mockUsdBalance,
      ]);
      revolutXMockState.getTickers.mockResolvedValueOnce({
        data: [mockTicker],
        metadata: { timestamp: 1700000000000 },
      });
    },
    assertions: [
      a.callsTool("get_balances"),
      a.callsTool("get_tickers"),
      a.judge({
        name: "answer is correct, complete, and concise",
        criterion:
          "The answer reports BOTH the BTC balance (1.5) and USD balance (10000), AND the BTC price (around 95050). It does not invent values absent from tool results. It is concise.",
        rubric:
          "1.0 = all three numbers correct and answer concise. 0.7 = correct but verbose. 0.4 = one number missing or wrong. 0.0 = hallucinations or major errors.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "ex5-semantic-no-active-orders",
    description:
      "Semantic similarity: semanticallyMatches (single), semanticallyMatchesAny (OR), semanticallyMatchesAvg (mean)",
    prompt: "Do I have any active orders on my account right now?",
    setup: () => {
      revolutXMockState.getActiveOrders.mockResolvedValueOnce({
        data: [],
        cursor: null,
        hasMore: false,
      });
    },
    assertions: [
      a.callsTool("get_active_orders"),
      a.semanticallyMatches({
        name: "expresses 'no active orders' (single reference)",
        reference: "You currently have no active orders on your account.",
        threshold: 0.6,
      }),
      a.semanticallyMatchesAny({
        name: "paraphrases empty-orders message (any reference)",
        references: [
          "You have no active orders.",
          "Your active order list is empty.",
          "There are no open orders right now.",
          "No orders at the moment.",
        ],
        threshold: 0.65,
      }),
      a.semanticallyMatchesAvg({
        name: "covers both 'orders' and 'none' concepts (averaged)",
        references: ["active orders", "nothing currently open"],
        threshold: 0.3,
      }),
    ],
  });

  defineEval({
    name: "ex6-negative-judge-no-fabrication",
    description:
      "Negative-style judge: assert what the answer must NOT do (fabrication guard)",
    prompt: "What's the current BTC price?",
    setup: () => {
      revolutXMockState.getTickers.mockResolvedValueOnce({
        data: [{ ...mockTicker, last_price: "95050" }],
        metadata: { timestamp: 1700000000000 },
      });
    },
    assertions: [
      a.callsTool("get_tickers"),
      a.doesNotCallTool("get_candles"),
      a.judge({
        name: "answer does not fabricate values outside tool results",
        criterion:
          "The answer states BTC is around 95050. It does NOT invent a different price, predictions, or values not present in the tool result.",
        rubric:
          "1.0 = states 95050 with no invented numbers. 0.5 = correct but adds one unsupported claim. 0.0 = wrong number or significant fabrication.",
        threshold: 0.8,
      }),
    ],
  });
});
