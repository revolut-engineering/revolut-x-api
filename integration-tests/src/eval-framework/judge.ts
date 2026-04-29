import type Anthropic from "@anthropic-ai/sdk";
import type {
  AssertionContext,
  AssertionOutcome,
  JudgeAssertion,
} from "./types.js";
import { JudgeResponseSchema } from "./schemas.js";
import { estimateCostUsd } from "./pricing.js";
import { JudgeParseError, serializeError } from "./errors.js";

export const DEFAULT_JUDGE_THRESHOLD = 0.7;

export interface JudgeRunResult {
  outcome: AssertionOutcome;
  cost: number;
}

export function passesThreshold(score: number, threshold: number): boolean {
  if (!Number.isFinite(score) || !Number.isFinite(threshold)) return false;
  return score >= threshold;
}

export async function runJudge(
  assertion: JudgeAssertion,
  ctx: AssertionContext,
  anthropic: Anthropic,
  defaultModel: string,
  maxTokens: number,
): Promise<JudgeRunResult> {
  const model = assertion.model ?? defaultModel;
  const threshold = assertion.threshold ?? DEFAULT_JUDGE_THRESHOLD;
  const systemPrompt = buildJudgeSystemPrompt(assertion);
  const userPrompt = buildJudgeUserPrompt(ctx);

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const cost = estimateCostUsd(model, {
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      cacheCreationInputTokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = parseAndValidateJudgeResponse(text);
    if (!parsed.ok) {
      return {
        cost,
        outcome: {
          name: assertion.name,
          kind: "judge",
          passed: false,
          score: 0,
          error: `Judge response invalid: ${parsed.message}. Raw: ${text.slice(0, 500)}`,
        },
      };
    }

    return {
      cost,
      outcome: {
        name: assertion.name,
        kind: "judge",
        passed: passesThreshold(parsed.value.score, threshold),
        score: parsed.value.score,
        reasoning: parsed.value.reasoning,
      },
    };
  } catch (error) {
    return {
      cost: 0,
      outcome: {
        name: assertion.name,
        kind: "judge",
        passed: false,
        score: 0,
        error: JSON.stringify(serializeError(error)),
      },
    };
  }
}

function buildJudgeSystemPrompt(assertion: JudgeAssertion): string {
  const rubric =
    assertion.rubric ??
    "Score 1.0 if the criterion is fully met, 0.0 if not met at all, and a value in between for partial credit. Be strict.";
  return [
    "You are an evaluation judge. Score whether the agent's output meets a specific criterion.",
    "",
    `CRITERION: ${assertion.criterion}`,
    "",
    `RUBRIC: ${rubric}`,
    "",
    "Output JSON only, no other text. Schema:",
    `{"score": <number 0..1>, "reasoning": "<one short sentence explaining the score>"}`,
  ].join("\n");
}

function buildJudgeUserPrompt(ctx: AssertionContext): string {
  const toolSummary = ctx.toolCalls
    .map((c) => `- ${c.name}(${JSON.stringify(c.args)})`)
    .join("\n");
  const sections = [
    "USER PROMPT:",
    ctx.prompt,
    "",
    "AGENT TOOL CALLS:",
    toolSummary || "(none)",
    "",
    "AGENT FINAL ANSWER:",
    ctx.finalText || "(empty)",
  ];
  return sections.join("\n");
}

type ParseResult =
  | { ok: true; value: { score: number; reasoning: string } }
  | { ok: false; message: string };

function parseAndValidateJudgeResponse(text: string): ParseResult {
  const json = extractFirstJsonObject(text);
  if (json === null) return { ok: false, message: "no JSON object found" };
  const parsed = JudgeResponseSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { ok: false, message: issues };
  }
  return { ok: true, value: parsed.data };
}

function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export { JudgeParseError };
