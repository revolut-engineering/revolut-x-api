import { z } from "zod";

export const ConnectionCreateSchema = z.object({
  bot_token: z.string().min(1),
  chat_id: z.string().min(1),
  label: z.string().min(1).max(128),
  test: z.boolean().default(false),
});
export type ConnectionCreate = z.infer<typeof ConnectionCreateSchema>;

export const ConnectionUpdateSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  label: z.string().min(1).max(128).nullable().optional(),
});
export type ConnectionUpdate = z.infer<typeof ConnectionUpdateSchema>;

export const TestConnectionRequestSchema = z.object({
  message: z.string().default(""),
});
export type TestConnectionRequest = z.infer<typeof TestConnectionRequestSchema>;

export const TestResultSchema = z.object({
  success: z.boolean(),
  error: z.string().nullable().optional(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const ConnectionResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  bot_token_redacted: z.string(),
  chat_id: z.string(),
  enabled: z.boolean(),
  last_tested_at: z.string().datetime().nullable(),
  last_test_error: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ConnectionResponse = z.infer<typeof ConnectionResponseSchema>;

export const ConnectionCreateResponseSchema = ConnectionResponseSchema.extend({
  test_result: TestResultSchema.nullable().optional(),
});
export type ConnectionCreateResponse = z.infer<typeof ConnectionCreateResponseSchema>;

export const ConnectionListResponseSchema = z.object({
  data: z.array(ConnectionResponseSchema),
  total: z.number().int(),
});
export type ConnectionListResponse = z.infer<typeof ConnectionListResponseSchema>;
