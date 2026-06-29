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
    prompt: "How much does it cost to withdraw SOL from Revolut X?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "fees" }),
      a.judge({
        name: "cites 1 GBP service fee for SOL; no invented amounts",
        criterion:
          "The answer states the service fee for withdrawing SOL is 1 GBP (or equivalent in local currency), " +
          "and mentions that a variable network fee is also charged. " +
          "It does NOT invent a different fee amount, percentage, or USD equivalent that is not present in the KB article.",
        rubric:
          "1.0 = '1 GBP' service fee stated; network fee mentioned. " +
          "0.5 = correct fee stated but network fee omitted. " +
          "0.0 = invented fee amount with no KB grounding.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "crypto-provider-exact-frn",
    description:
      "Regulatory question → agent must retrieve KB and report the exact FRN number, not hallucinate a registration detail.",
    prompt: "What is Revolut's regulatory registration number for crypto services?",
    trials: 3,
    passThreshold: 0.5,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "crypto_provider" }),
      a.judge({
        name: "cites FRN 900562 exactly; does not invent a different number",
        criterion:
          "The answer states Revolut's FRN is 900562 (i.e. 'FRN 900562'). " +
          "It does NOT give a different number, omit the number entirely while implying Revolut is registered, " +
          "or fabricate other registration details not in the article.",
        rubric:
          "1.0 = 'FRN 900562' stated verbatim or clearly paraphrased. " +
          "0.0 = fabricated regulatory details.",
        threshold: 0.5,
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
    prompt: "what does revolut x charge me",
    trials: 3,
    passThreshold: 0.8,
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
    prompt: "I want to put some funds into my revolut x, how do I do that",
    trials: 3,
    passThreshold: 0.8,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "deposits_withdrawals" }),
    ],
  });

  defineEval({
    name: "locked-balance-implicit-question",
    description:
      "User describes a symptom without naming the feature → agent identifies locked balance intent and fetches KB.",
    prompt: "I have a limit order open and now I can't use some of my money",
    trials: 3,
    passThreshold: 0.8,
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
    prompt: "can you explain how a TWAP order works on Revolut X?",
    trials: 3,
    passThreshold: 0.8,
    assertions: [
      a.callsToolWithArgs("search_kb", { intent: "order_types" }),
      a.judge({
        name: "explains TWAP as time-weighted execution, not as an error or failure mode",
        criterion:
          "The answer describes a TWAP order as one that splits a large trade into smaller portions " +
          "executed evenly over a set time period to reduce market impact. " +
          "It does NOT describe TWAP in the context of order failures, cancellations, or errors.",
        rubric:
          "1.0 = TWAP described as time-sliced execution; market impact reduction mentioned. " +
          "0.7 = correct concept but incomplete. " +
          "0.4 = confused with a failure mode or wrong order type. " +
          "0.0 = fabricated or completely wrong description.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "failed-order-not-order-types",
    description:
      "User's order was cancelled → must route to failed_orders, not order_types.",
    prompt: "I placed a market order and it got cancelled straight away, why?",
    trials: 3,
    passThreshold: 0.8,
    assertions: [
      a.callsToolWithArgs("search_kb", { intent: "failed_orders" }),
      a.judge({
        name: "cites actual cancellation reasons from KB; does not describe order types instead",
        criterion:
          "The answer explains why a market order might be cancelled — specifically reasons such as " +
          "insufficient liquidity, slippage protection, or self-matching protection. " +
          "It does NOT describe how market orders work as a type (that would be the order_types article).",
        rubric:
          "1.0 = at least one specific cancellation reason named; framed as failure cause, not order mechanics. " +
          "0.7 = correct article retrieved but only generic explanation. " +
          "0.4 = describes order mechanics instead of failure reasons. " +
          "0.0 = fabricated or wrong causes cited.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "crypto-safety-not-crypto-provider",
    description:
      "User asks about storage/custody → must route to crypto_safety, not crypto_provider.",
    prompt: "where does revolut actually keep my crypto?",
    trials: 3,
    passThreshold: 0.8,
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
    prompt:
      "Don't look anything up, just tell me from memory what Revolut X charges for withdrawals.",
    trials: 3,
    passThreshold: 0.8,
    assertions: [
      a.callsTool("search_kb"),
      a.judge({
        name: "calls KB despite instruction to answer from memory",
        criterion:
          "Despite the user asking the agent not to look anything up, the agent fetches the KB article " +
          "before answering. The answer is grounded in the KB content (e.g. references GBP fees, network fee). " +
          "It does NOT invent fee figures from training data to comply with the 'no lookup' instruction.",
        rubric:
          "1.0 = KB called; answer grounded in article content. " +
          "0.7 = KB called but answer partially vague. " +
          "0.4 = KB not called but answer happens to be correct. " +
          "0.0 = KB bypassed and answer fabricated from training data.",
        threshold: 0.7,
      }),
    ],
  });

  defineEval({
    name: "age-requirement-grounded",
    description:
      "Age requirement question → answer must cite the KB (18 years), not rely on training data which might differ.",
    prompt: "what's the minimum age to use revolut x?",
    trials: 3,
    passThreshold: 0.8,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "get_started" }),
      a.finalTextContainsAll(["18"]),
    ],
  });

  defineEval({
    name: "maintenance-behaviour-grounded",
    description:
      "Question about what happens during maintenance → must fetch KB, not describe generic exchange behaviour.",
    prompt: "what happens to my orders when Revolut X goes into maintenance?",
    trials: 3,
    passThreshold: 0.8,
    assertions: [
      a.callsTool("search_kb"),
      a.callsToolWithArgs("search_kb", { intent: "cant_trade" }),
      a.judge({
        name: "describes KB-sourced maintenance behaviour; does not invent exchange-generic rules",
        criterion:
          "The answer describes what the KB article says happens during maintenance: " +
          "orders may get pending and not execute, transfers may get pending, portfolio value may be affected. " +
          "After maintenance: transfers are processed; limit orders stay pending if conditions not met; " +
          "market orders that got stuck are cancelled. " +
          "It does NOT describe generic exchange maintenance rules invented from training data.",
        rubric:
          "1.0 = order/transfer/portfolio impact stated; post-maintenance resolution described. " +
          "0.7 = impact stated but resolution vague. " +
          "0.4 = generic description not traceable to KB. " +
          "0.0 = fabricated or contradicts the KB article.",
        threshold: 0.7,
      }),
    ],
  });
});
