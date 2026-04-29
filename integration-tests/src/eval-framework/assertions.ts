import { z } from "zod";
import { EvalConfigError } from "./errors.js";
import {
  AssertionSchema,
  type Assertion,
  type AssertionContext,
  type JudgeAssertion,
  type PredicateAssertion,
  type SemanticAssertion,
} from "./schemas.js";

function ensureValid<T extends Assertion>(assertion: T, label: string): T {
  const result = AssertionSchema.safeParse(assertion);
  if (!result.success) {
    throw new EvalConfigError(`invalid assertion in ${label}`, {
      assertion,
      issues: result.error.issues,
    });
  }
  return assertion;
}

function predicate(
  name: string,
  check: (ctx: AssertionContext) => boolean | Promise<boolean>,
): PredicateAssertion {
  return ensureValid(
    { kind: "predicate", name, check },
    `a.predicate("${name}")`,
  );
}

function namedPredicate(
  name: string | undefined,
  fallback: string,
  check: (ctx: AssertionContext) => boolean | Promise<boolean>,
): PredicateAssertion {
  return predicate(name ?? fallback, check);
}

function deepIncludes(partial: unknown, actual: unknown): boolean {
  if (partial === null || partial === undefined) return partial === actual;
  if (typeof partial !== "object") return partial === actual;
  if (typeof actual !== "object" || actual === null) return false;
  if (Array.isArray(partial)) {
    if (!Array.isArray(actual)) return false;
    return partial.every((p) => actual.some((a) => deepIncludes(p, a)));
  }
  for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
    if (!deepIncludes(v, (actual as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (item === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const x of b) {
    const n = counts.get(x);
    if (!n) return false;
    counts.set(x, n - 1);
  }
  return [...counts.values()].every((n) => n === 0);
}

const NonEmptyName = z.string().min(1);
const NonEmptyArray = z.array(NonEmptyName).min(1);
const PositiveInt = z
  .number()
  .int()
  .refine((n) => n > 0, "must be > 0");
const NonNegInt = z
  .number()
  .int()
  .refine((n) => n >= 0, "must be >= 0");

function expect<T>(value: T, schema: z.ZodType<T>, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new EvalConfigError(`invalid argument to ${label}`, {
      value,
      issues: result.error.issues,
    });
  }
  return result.data;
}

export const a = {
  callsTool(toolName: string, name?: string): Assertion {
    expect(toolName, NonEmptyName, "a.callsTool(toolName)");
    return namedPredicate(name, `calls ${toolName}`, ({ toolCalls }) =>
      toolCalls.some((c) => c.name === toolName),
    );
  },

  doesNotCallTool(toolName: string, name?: string): Assertion {
    expect(toolName, NonEmptyName, "a.doesNotCallTool(toolName)");
    return namedPredicate(
      name,
      `does not call ${toolName}`,
      ({ toolCalls }) => !toolCalls.some((c) => c.name === toolName),
    );
  },

  callsToolWithArgs(
    toolName: string,
    partialArgs: Record<string, unknown>,
    name?: string,
  ): Assertion {
    expect(toolName, NonEmptyName, "a.callsToolWithArgs(toolName)");
    return namedPredicate(
      name,
      `${toolName} called with ${JSON.stringify(partialArgs)}`,
      ({ toolCalls }) =>
        toolCalls.some(
          (c) => c.name === toolName && deepIncludes(partialArgs, c.args),
        ),
    );
  },

  callsToolNTimes(toolName: string, n: number, name?: string): Assertion {
    expect(toolName, NonEmptyName, "a.callsToolNTimes(toolName)");
    expect(n, NonNegInt, "a.callsToolNTimes(n)");
    return namedPredicate(
      name,
      `${toolName} called ${n} time(s)`,
      ({ toolCalls }) =>
        toolCalls.filter((c) => c.name === toolName).length === n,
    );
  },

  callsExactly(toolNames: string[], name?: string): Assertion {
    expect(toolNames, NonEmptyArray, "a.callsExactly(toolNames)");
    return namedPredicate(
      name,
      `calls exactly: ${toolNames.join(", ")} (any order)`,
      ({ toolCalls }) =>
        multisetEqual(
          toolCalls.map((c) => c.name),
          toolNames,
        ),
    );
  },

  callsInOrder(toolNames: string[], name?: string): Assertion {
    expect(toolNames, NonEmptyArray, "a.callsInOrder(toolNames)");
    return namedPredicate(
      name,
      `calls in order (subsequence): ${toolNames.join(" → ")}`,
      ({ toolCalls }) =>
        isSubsequence(
          toolNames,
          toolCalls.map((c) => c.name),
        ),
    );
  },

  callsExactlyInOrder(toolNames: string[], name?: string): Assertion {
    expect(toolNames, NonEmptyArray, "a.callsExactlyInOrder(toolNames)");
    return namedPredicate(
      name,
      `calls exactly in order: ${toolNames.join(" → ")}`,
      ({ toolCalls }) => {
        const actual = toolCalls.map((c) => c.name);
        if (actual.length !== toolNames.length) return false;
        return actual.every((n, i) => n === toolNames[i]);
      },
    );
  },

  finalTextMatches(re: RegExp, name?: string): Assertion {
    if (!(re instanceof RegExp)) {
      throw new EvalConfigError("a.finalTextMatches requires a RegExp", {
        received: typeof re,
      });
    }
    return namedPredicate(name, `final text matches ${re}`, ({ finalText }) =>
      re.test(finalText),
    );
  },

  finalTextContainsAll(strings: string[], name?: string): Assertion {
    expect(strings, NonEmptyArray, "a.finalTextContainsAll(strings)");
    return namedPredicate(
      name,
      `final text contains all of: ${strings.join(", ")}`,
      ({ finalText }) =>
        strings.every((s) => finalText.toLowerCase().includes(s.toLowerCase())),
    );
  },

  endsTurn(name?: string): Assertion {
    return namedPredicate(
      name,
      "agent ended on end_turn",
      ({ stopReason }) => stopReason === "end_turn",
    );
  },

  withinTokenBudget(maxOutputTokens: number, name?: string): Assertion {
    expect(
      maxOutputTokens,
      PositiveInt,
      "a.withinTokenBudget(maxOutputTokens)",
    );
    return namedPredicate(
      name,
      `within ${maxOutputTokens} output tokens`,
      ({ usage }) => usage.outputTokens <= maxOutputTokens,
    );
  },

  withinLatency(maxMs: number, name?: string): Assertion {
    expect(maxMs, PositiveInt, "a.withinLatency(maxMs)");
    return namedPredicate(
      name,
      `within ${maxMs}ms`,
      ({ durationMs }) => durationMs <= maxMs,
    );
  },

  judge(opts: Omit<JudgeAssertion, "kind">): JudgeAssertion {
    return ensureValid({ kind: "judge", ...opts }, `a.judge("${opts.name}")`);
  },

  semanticallyMatches(opts: {
    name: string;
    reference: string;
    threshold?: number;
  }): SemanticAssertion {
    return ensureValid(
      {
        kind: "semantic",
        name: opts.name,
        reference: opts.reference,
        threshold: opts.threshold,
        mode: "any",
      },
      `a.semanticallyMatches("${opts.name}")`,
    );
  },

  semanticallyMatchesAny(opts: {
    name: string;
    references: string[];
    threshold?: number;
  }): SemanticAssertion {
    return ensureValid(
      {
        kind: "semantic",
        name: opts.name,
        references: opts.references,
        threshold: opts.threshold,
        mode: "any",
      },
      `a.semanticallyMatchesAny("${opts.name}")`,
    );
  },

  semanticallyMatchesAvg(opts: {
    name: string;
    references: string[];
    threshold?: number;
  }): SemanticAssertion {
    return ensureValid(
      {
        kind: "semantic",
        name: opts.name,
        references: opts.references,
        threshold: opts.threshold,
        mode: "avg",
      },
      `a.semanticallyMatchesAvg("${opts.name}")`,
    );
  },
};
