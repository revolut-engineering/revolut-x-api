import { describe, vi } from "vitest";

vi.mock("@revolut/revolut-x-api", async () => {
  const { buildRevolutXMockModule } =
    await import("../src/harness/revolut-x-mock.js");
  return buildRevolutXMockModule();
});

const { defineEval, a } = await import("../src/eval-framework/index.js");

// ─── Hallucination ────────────────────────────────────────────────────────────
// The agent must cite specific facts from the KB article, not invent plausible
// numbers or descriptions from training data.

describe("kb — hallucination", () => {
  defineEval({
    name: "withdrawal-fee-exact-amount",
    description:
      "Fee question with a known exact answer → agent must retrieve KB and report '1 GBP' for SOL, not invent a number.",
    failureModes: ["Hallucination"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "How much does it cost to withdraw SOL from Revolut X?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "fees" }),
      a.judge({
        name: "cites 1 GBP service fee for SOL; no invented amounts",
        criterion:
          "Pass if: the answer states the service fee for withdrawing SOL is 1 GBP (or equivalent in local currency) and mentions that a variable network fee is also charged. " +
          "Fail if: a different fee amount is given, the fee is invented without KB grounding, or no fee information is provided.",
      }),
    ],
  });

  defineEval({
    name: "crypto-provider-exact-frn",
    description:
      "Regulatory question → agent must retrieve KB and report the exact FRN number, not hallucinate a registration detail.",
    failureModes: ["Hallucination"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt:
      "What is Revolut's regulatory registration number for crypto services?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "crypto_provider" }),
      a.judge({
        name: "cites FRN 900562 exactly; does not invent a different number",
        criterion:
          "Pass if: the answer states Revolut's FRN is 900562 (verbatim or clearly paraphrased). " +
          "Fail if: a different number is given, the number is omitted while implying Revolut is registered, or registration details are fabricated.",
      }),
    ],
  });
});

// ─── Poor recall ──────────────────────────────────────────────────────────────
// The agent must call search_kb for any platform-specific question, even when
// the phrasing is casual or indirect.

describe("kb — poor recall", () => {
  defineEval({
    name: "casual-fee-question",
    description:
      "Casual fee question phrased without buzzwords → agent must still route to KB, not answer from training data.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "what does revolut x charge me",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "fees" }),
      a.doesNotCallTool("get_balances"),
    ],
  });

  defineEval({
    name: "indirect-deposit-question",
    description:
      "User asks how to add money using indirect phrasing → agent must look it up in KB.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "I want to put some funds into my revolut x, how do I do that",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "deposits_withdrawals" }),
    ],
  });

  defineEval({
    name: "locked-balance-implicit-question",
    description:
      "User describes a symptom without naming the feature → agent identifies locked balance intent and fetches KB.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "I have a limit order open and now I can't use some of my money",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "locked_balance" }),
    ],
  });
});

// ─── Poor precision ───────────────────────────────────────────────────────────
// The agent must call search_kb with the correct intent for the question, not
// pick a plausible-sounding but wrong article.

describe("kb — poor precision", () => {
  defineEval({
    name: "order-types-not-failed-orders",
    description:
      "User asks how TWAP works → must route to order_types, not failed_orders or another intent.",
    failureModes: ["Bad tool resolution", "Hallucination"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "can you explain how a TWAP order works on Revolut X?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsToolWithArgs("search_kb", { intent: "order_types" }),
      a.judge({
        name: "explains TWAP as time-weighted execution, not as an error or failure mode",
        criterion:
          "Pass if: the answer describes a TWAP order as splitting a large trade into smaller portions executed over a set time period to reduce market impact; the description may be incomplete in secondary details. " +
          "Fail if: TWAP is described as a failure mode, confused with another order type, or the description is fabricated or fundamentally wrong.",
      }),
    ],
  });

  defineEval({
    name: "failed-order-not-order-types",
    description:
      "User's order was cancelled → must route to failed_orders, not order_types.",
    failureModes: ["Bad tool resolution", "Hallucination"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "I placed a market order and it got cancelled straight away, why?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsToolWithArgs("search_kb", { intent: "failed_orders" }),
      a.judge({
        name: "cites actual cancellation reasons from KB; does not describe order types instead",
        criterion:
          "Pass if: the answer names at least one specific reason a market order might be cancelled (e.g. insufficient liquidity, slippage protection, self-matching protection), framed as a failure cause; a generic explanation is acceptable. " +
          "Fail if: the answer only describes how market orders work without naming failure causes, or the causes cited are fabricated or wrong.",
      }),
    ],
  });

  defineEval({
    name: "crypto-safety-not-crypto-provider",
    description:
      "User asks about storage/custody → must route to crypto_safety, not crypto_provider.",
    failureModes: ["Bad tool resolution"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "where does revolut actually keep my crypto?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsToolWithArgs("search_kb", { intent: "crypto_safety" }),
      a.finalTextContainsAll(["cold storage"]),
    ],
  });
});

// ─── Ungrounded claims ────────────────────────────────────────────────────────
// The agent must not bypass the KB to answer platform questions from training
// data, even when explicitly asked to, or when the topic seems "obvious".

describe("kb — ungrounded claims", () => {
  defineEval({
    name: "no-bypass-when-asked-from-memory",
    description:
      "User explicitly asks agent to answer from memory → agent must still call KB per mandatory policy.",
    failureModes: ["Hallucination"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt:
      "Don't look anything up, just tell me from memory what Revolut X charges for withdrawals.",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.judge({
        name: "calls KB despite instruction to answer from memory",
        criterion:
          "Pass if: the agent calls search_kb before answering, and the answer references KB content (e.g. GBP fees, network fee); the answer may be vague. " +
          "Fail if: the KB is not called, or the answer is fabricated from training data regardless of whether it happens to be correct.",
      }),
    ],
  });

  defineEval({
    name: "maintenance-behaviour-grounded",
    description:
      "Question about what happens during maintenance → must fetch KB, not describe generic exchange behaviour.",
    failureModes: ["Hallucination"],
    granularity: "Tool-specific",
    workflow: "Support",
    prompt: "what happens to my orders when Revolut X goes into maintenance?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "cant_trade" }),
      a.judge({
        name: "describes KB-sourced maintenance behaviour; does not invent exchange-generic rules",
        criterion:
          "Pass if: the answer describes the impact during maintenance (orders pending, transfers pending, portfolio affected); post-maintenance resolution may be vague or omitted. " +
          "Fail if: the description is generic exchange behaviour not traceable to the KB, contradicts the KB article, or is fabricated.",
      }),
    ],
  });
});
