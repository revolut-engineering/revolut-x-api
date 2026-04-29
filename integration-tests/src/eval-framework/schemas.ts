import { z } from "zod";

const FiniteNumber = z.number().refine(Number.isFinite, {
  message: "must be a finite number",
});
const NonNegativeFinite = FiniteNumber.refine((n) => n >= 0, {
  message: "must be non-negative",
});
const PositiveInt = z
  .number()
  .int()
  .refine((n) => n > 0 && Number.isFinite(n), {
    message: "must be a positive integer",
  });

const Score = FiniteNumber.refine((n) => n >= 0 && n <= 1, {
  message: "must be in [0, 1]",
});
const Threshold = Score;

const UsageTotalsSchema = z.object({
  inputTokens: NonNegativeFinite,
  outputTokens: NonNegativeFinite,
  cacheCreationInputTokens: NonNegativeFinite.optional(),
  cacheReadInputTokens: NonNegativeFinite.optional(),
});

const ToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()),
  result: z.unknown(),
  turn: z.number().int().nonnegative(),
});

const AgentResultSchema = z.object({
  toolCalls: z.array(ToolCallSchema),
  finalText: z.string(),
  turns: z.number().int().nonnegative(),
  stopReason: z.string(),
  durationMs: NonNegativeFinite,
  usage: UsageTotalsSchema,
  model: z.string().min(1),
});

export const AssertionKindSchema = z.enum(["predicate", "judge", "semantic"]);
export type AssertionKind = z.infer<typeof AssertionKindSchema>;

const PredicateOutcomeSchema = z.object({
  kind: z.literal("predicate"),
  name: z.string().min(1),
  passed: z.boolean(),
  error: z.string().optional(),
});

const JudgeOutcomeSchema = z.object({
  kind: z.literal("judge"),
  name: z.string().min(1),
  passed: z.boolean(),
  score: Score,
  reasoning: z.string().optional(),
  error: z.string().optional(),
});

const SemanticOutcomeSchema = z.object({
  kind: z.literal("semantic"),
  name: z.string().min(1),
  passed: z.boolean(),
  score: Score,
  reasoning: z.string().optional(),
  error: z.string().optional(),
});

export const AssertionOutcomeSchema = z.discriminatedUnion("kind", [
  PredicateOutcomeSchema,
  JudgeOutcomeSchema,
  SemanticOutcomeSchema,
]);
export type AssertionOutcome = z.infer<typeof AssertionOutcomeSchema>;

export const TrialResultSchema = z.object({
  trial: z.number().int().nonnegative(),
  passed: z.boolean(),
  durationMs: NonNegativeFinite,
  agent: AgentResultSchema,
  assertions: z.array(AssertionOutcomeSchema),
  cost: NonNegativeFinite,
  judgeCost: NonNegativeFinite,
  embeddingCost: NonNegativeFinite,
  error: z.string().optional(),
});
export type TrialResult = z.infer<typeof TrialResultSchema>;

export const EvalResultSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().min(1),
  trials: z.array(TrialResultSchema),
  trialCount: z.number().int().nonnegative(),
  passes: z.number().int().nonnegative(),
  passRate: Score,
  threshold: Threshold,
  passed: z.boolean(),
  durationMs: NonNegativeFinite,
  totalCost: NonNegativeFinite,
  totalJudgeCost: NonNegativeFinite,
  totalEmbeddingCost: NonNegativeFinite,
  totalInputTokens: NonNegativeFinite,
  totalOutputTokens: NonNegativeFinite,
  assertionPassRates: z.record(Score),
  assertionMeanScores: z.record(Score.nullable()),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

export const RunMetadataSchema = z.object({
  runId: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1).optional(),
  model: z.string().min(1),
  judgeModel: z.string().min(1),
  embeddingProvider: z.string().min(1),
  embeddingModel: z.string().min(1),
  repetitions: PositiveInt,
  passThreshold: Threshold,
});
export type RunMetadata = z.infer<typeof RunMetadataSchema>;

export const RunReportSchema = z.object({
  metadata: RunMetadataSchema,
  results: z.array(EvalResultSchema),
  totalCost: NonNegativeFinite,
  totalJudgeCost: NonNegativeFinite,
  totalEmbeddingCost: NonNegativeFinite,
  totalDurationMs: NonNegativeFinite,
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
});
export type RunReport = z.infer<typeof RunReportSchema>;

const AssertionContextSchema = AgentResultSchema.extend({
  prompt: z.string(),
});
export type AssertionContext = z.infer<typeof AssertionContextSchema>;

const PredicateAssertionInputSchema = z.object({
  kind: z.literal("predicate").optional(),
  name: z.string().min(1),
  check: z
    .function()
    .args(AssertionContextSchema)
    .returns(z.union([z.boolean(), z.promise(z.boolean())])),
});

const JudgeAssertionInputSchema = z.object({
  kind: z.literal("judge"),
  name: z.string().min(1),
  criterion: z.string().min(1),
  rubric: z.string().min(1).optional(),
  threshold: Threshold.optional(),
  model: z.string().min(1).optional(),
});

const SemanticAssertionInputSchema = z
  .object({
    kind: z.literal("semantic"),
    name: z.string().min(1),
    reference: z.string().min(1).optional(),
    references: z.array(z.string().min(1)).min(1).optional(),
    threshold: Threshold.optional(),
    mode: z.enum(["any", "avg"]).optional(),
  })
  .refine((data) => Boolean(data.reference) !== Boolean(data.references), {
    message:
      "exactly one of `reference` or `references` must be provided (and non-empty)",
  });

export const AssertionSchema = z.union([
  PredicateAssertionInputSchema,
  JudgeAssertionInputSchema,
  SemanticAssertionInputSchema,
]);

export type PredicateAssertion = z.infer<typeof PredicateAssertionInputSchema>;
export type JudgeAssertion = z.infer<typeof JudgeAssertionInputSchema>;
export type SemanticAssertion = z.infer<typeof SemanticAssertionInputSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;

export const EvalCaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  prompt: z.string().min(1),
  setup: z
    .function()
    .args()
    .returns(z.union([z.void(), z.promise(z.void())]))
    .optional(),
  assertions: z.array(AssertionSchema).min(1),
  trials: PositiveInt.optional(),
  passThreshold: Threshold.optional(),
  model: z.string().min(1).optional(),
  maxIterations: PositiveInt.optional(),
  systemPrompt: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const JudgeResponseSchema = z.object({
  score: Score,
  reasoning: z.string().min(1),
});
export type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

export const Schemas = {
  AssertionOutcomeSchema,
  AssertionSchema,
  EvalCaseSchema,
  EvalResultSchema,
  JudgeResponseSchema,
  RunMetadataSchema,
  RunReportSchema,
  TrialResultSchema,
};
