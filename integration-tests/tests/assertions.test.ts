import { describe, it, expect } from "vitest";
import { a } from "../src/eval-framework/index.js";
import type {
  AssertionContext,
  PredicateAssertion,
} from "../src/eval-framework/types.js";

function ctx(overrides: Partial<AssertionContext> = {}): AssertionContext {
  return {
    prompt: "test",
    toolCalls: [],
    finalText: "",
    turns: 0,
    stopReason: "end_turn",
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "test-model",
    ...overrides,
  };
}

function callsToolEntry(
  name: string,
  args: Record<string, unknown> = {},
  turn = 0,
) {
  return {
    name,
    args,
    result: { content: [], isError: false },
    turn,
  };
}

async function runCheck(
  assertion: ReturnType<typeof a.callsTool>,
  context: AssertionContext,
): Promise<boolean> {
  const predicate = assertion as PredicateAssertion;
  return Boolean(await predicate.check(context));
}

describe("a.callsTool", () => {
  it("passes when tool is in trace", async () => {
    const assertion = a.callsTool("get_balances");
    const c = ctx({ toolCalls: [callsToolEntry("get_balances")] });
    expect(await runCheck(assertion, c)).toBe(true);
  });

  it("fails when tool is missing", async () => {
    const assertion = a.callsTool("get_balances");
    expect(await runCheck(assertion, ctx())).toBe(false);
  });

  it("rejects empty tool name at construction", () => {
    expect(() => a.callsTool("")).toThrow(/invalid argument/);
  });
});

describe("a.doesNotCallTool", () => {
  it("passes when tool is absent", async () => {
    const assertion = a.doesNotCallTool("danger");
    expect(await runCheck(assertion, ctx())).toBe(true);
  });

  it("fails when tool is present", async () => {
    const assertion = a.doesNotCallTool("danger");
    const c = ctx({ toolCalls: [callsToolEntry("danger")] });
    expect(await runCheck(assertion, c)).toBe(false);
  });
});

describe("a.callsToolWithArgs", () => {
  it("matches partial args", async () => {
    const assertion = a.callsToolWithArgs("x", { foo: 1 });
    const c = ctx({
      toolCalls: [callsToolEntry("x", { foo: 1, extra: 2 })],
    });
    expect(await runCheck(assertion, c)).toBe(true);
  });

  it("rejects mismatched args", async () => {
    const assertion = a.callsToolWithArgs("x", { foo: 1 });
    const c = ctx({ toolCalls: [callsToolEntry("x", { foo: 2 })] });
    expect(await runCheck(assertion, c)).toBe(false);
  });

  it("matches arrays as 'every element appears in actual'", async () => {
    const assertion = a.callsToolWithArgs("x", { tags: ["a"] });
    const c = ctx({
      toolCalls: [callsToolEntry("x", { tags: ["a", "b"] })],
    });
    expect(await runCheck(assertion, c)).toBe(true);
  });
});

describe("a.callsToolNTimes", () => {
  it("passes when count matches exactly", async () => {
    const assertion = a.callsToolNTimes("x", 2);
    const c = ctx({
      toolCalls: [callsToolEntry("x"), callsToolEntry("x")],
    });
    expect(await runCheck(assertion, c)).toBe(true);
  });

  it("fails when count differs", async () => {
    const assertion = a.callsToolNTimes("x", 2);
    const c = ctx({ toolCalls: [callsToolEntry("x")] });
    expect(await runCheck(assertion, c)).toBe(false);
  });
});

describe("a.callsExactly", () => {
  it("passes for multiset equality", async () => {
    const assertion = a.callsExactly(["a", "b"]);
    const c = ctx({
      toolCalls: [callsToolEntry("b"), callsToolEntry("a")],
    });
    expect(await runCheck(assertion, c)).toBe(true);
  });

  it("fails when extras present", async () => {
    const assertion = a.callsExactly(["a"]);
    const c = ctx({
      toolCalls: [callsToolEntry("a"), callsToolEntry("b")],
    });
    expect(await runCheck(assertion, c)).toBe(false);
  });
});

describe("a.callsInOrder", () => {
  it("accepts subsequence with extras", async () => {
    const assertion = a.callsInOrder(["a", "c"]);
    const c = ctx({
      toolCalls: [
        callsToolEntry("a"),
        callsToolEntry("b"),
        callsToolEntry("c"),
      ],
    });
    expect(await runCheck(assertion, c)).toBe(true);
  });

  it("fails when order is wrong", async () => {
    const assertion = a.callsInOrder(["a", "c"]);
    const c = ctx({
      toolCalls: [callsToolEntry("c"), callsToolEntry("a")],
    });
    expect(await runCheck(assertion, c)).toBe(false);
  });
});

describe("a.callsExactlyInOrder", () => {
  it("requires exact length and order", async () => {
    const assertion = a.callsExactlyInOrder(["a", "b"]);
    const c = ctx({
      toolCalls: [callsToolEntry("a"), callsToolEntry("b")],
    });
    expect(await runCheck(assertion, c)).toBe(true);
  });

  it("fails on extra calls", async () => {
    const assertion = a.callsExactlyInOrder(["a", "b"]);
    const c = ctx({
      toolCalls: [
        callsToolEntry("a"),
        callsToolEntry("x"),
        callsToolEntry("b"),
      ],
    });
    expect(await runCheck(assertion, c)).toBe(false);
  });
});

describe("a.finalTextMatches", () => {
  it("matches on regex", async () => {
    const assertion = a.finalTextMatches(/btc/i);
    expect(await runCheck(assertion, ctx({ finalText: "BTC is up" }))).toBe(
      true,
    );
  });

  it("requires a RegExp argument", () => {
    expect(() =>
      a.finalTextMatches("not a regex" as unknown as RegExp),
    ).toThrow();
  });
});

describe("a.finalTextContainsAll", () => {
  it("is case-insensitive", async () => {
    const assertion = a.finalTextContainsAll(["BTC", "USD"]);
    expect(
      await runCheck(assertion, ctx({ finalText: "btc and usd are tickers" })),
    ).toBe(true);
  });

  it("fails if any string missing", async () => {
    const assertion = a.finalTextContainsAll(["BTC", "EUR"]);
    expect(await runCheck(assertion, ctx({ finalText: "BTC and USD" }))).toBe(
      false,
    );
  });
});

describe("a.endsTurn", () => {
  it("passes when stopReason is end_turn", async () => {
    const assertion = a.endsTurn();
    expect(await runCheck(assertion, ctx({ stopReason: "end_turn" }))).toBe(
      true,
    );
  });

  it("fails otherwise", async () => {
    const assertion = a.endsTurn();
    expect(await runCheck(assertion, ctx({ stopReason: "max_tokens" }))).toBe(
      false,
    );
  });
});

describe("a.withinTokenBudget", () => {
  it("passes under budget", async () => {
    const assertion = a.withinTokenBudget(100);
    const c = ctx({ usage: { inputTokens: 0, outputTokens: 50 } });
    expect(await runCheck(assertion, c)).toBe(true);
  });

  it("fails over budget", async () => {
    const assertion = a.withinTokenBudget(100);
    const c = ctx({ usage: { inputTokens: 0, outputTokens: 200 } });
    expect(await runCheck(assertion, c)).toBe(false);
  });

  it("rejects non-positive budget", () => {
    expect(() => a.withinTokenBudget(0)).toThrow();
  });
});

describe("a.withinLatency", () => {
  it("passes under budget", async () => {
    const assertion = a.withinLatency(1000);
    expect(await runCheck(assertion, ctx({ durationMs: 500 }))).toBe(true);
  });

  it("fails over budget", async () => {
    const assertion = a.withinLatency(1000);
    expect(await runCheck(assertion, ctx({ durationMs: 5000 }))).toBe(false);
  });
});

describe("a.judge / a.semantically*", () => {
  it("a.judge constructs a valid assertion", () => {
    const assertion = a.judge({
      name: "j",
      criterion: "ok",
    });
    expect(assertion.kind).toBe("judge");
  });

  it("a.judge rejects empty criterion", () => {
    expect(() => a.judge({ name: "j", criterion: "" })).toThrow();
  });

  it("a.semanticallyMatches constructs a valid semantic assertion", () => {
    const assertion = a.semanticallyMatches({
      name: "s",
      reference: "hi",
    });
    expect(assertion.kind).toBe("semantic");
    expect(assertion.reference).toBe("hi");
  });

  it("a.semanticallyMatches rejects empty reference", () => {
    expect(() => a.semanticallyMatches({ name: "s", reference: "" })).toThrow();
  });

  it("a.semanticallyMatchesAny rejects empty references array", () => {
    expect(() =>
      a.semanticallyMatchesAny({ name: "s", references: [] }),
    ).toThrow();
  });
});
