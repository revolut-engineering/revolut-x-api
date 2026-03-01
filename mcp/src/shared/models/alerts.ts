import { z } from "zod";

const ALERT_TYPES = [
  "price",
  "rsi",
  "ema_cross",
  "macd",
  "bollinger",
  "volume_spike",
  "spread",
  "obi",
  "price_change_pct",
  "atr_breakout",
] as const;

export const AlertTypeLiteral = z.enum(ALERT_TYPES);
export type AlertType = z.infer<typeof AlertTypeLiteral>;

export const ALL_ALERT_TYPES: readonly string[] = ALERT_TYPES;

const PAIR_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

export const AlertCreateSchema = z.object({
  pair: z.string().regex(PAIR_PATTERN, {
    message: "pair must match pattern ^[A-Z0-9]+-[A-Z0-9]+$ (e.g. BTC-USD)",
  }),
  alert_type: AlertTypeLiteral,
  config: z.record(z.unknown()).default({}),
  poll_interval_sec: z.number().int().min(5).default(10),
  connection_ids: z.array(z.string()).nullable().optional(),
});
export type AlertCreate = z.infer<typeof AlertCreateSchema>;

export const AlertUpdateSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  poll_interval_sec: z.number().int().min(5).nullable().optional(),
  connection_ids: z.array(z.string()).nullable().optional(),
});
export type AlertUpdate = z.infer<typeof AlertUpdateSchema>;

export const CurrentValueSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type CurrentValue = z.infer<typeof CurrentValueSchema>;

export const AlertResponseSchema = z.object({
  id: z.string(),
  pair: z.string(),
  alert_type: AlertTypeLiteral,
  config: z.record(z.unknown()),
  poll_interval_sec: z.number().int(),
  enabled: z.boolean(),
  triggered: z.boolean(),
  connection_ids: z.array(z.string()).nullable(),
  last_checked_at: z.string().datetime().nullable(),
  last_triggered_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  current_value: CurrentValueSchema.nullable().optional(),
});
export type AlertResponse = z.infer<typeof AlertResponseSchema>;

export const AlertListResponseSchema = z.object({
  data: z.array(AlertResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type AlertListResponse = z.infer<typeof AlertListResponseSchema>;

export const AlertTypeConfigFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  default: z.unknown().nullable().optional(),
  enum: z.array(z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
});
export type AlertTypeConfigField = z.infer<typeof AlertTypeConfigFieldSchema>;

export const AlertTypeInfoSchema = z.object({
  name: AlertTypeLiteral,
  description: z.string(),
  config_fields: z.array(AlertTypeConfigFieldSchema),
  example_config: z.record(z.unknown()),
});
export type AlertTypeInfo = z.infer<typeof AlertTypeInfoSchema>;

export const AlertTypesResponseSchema = z.object({
  data: z.array(AlertTypeInfoSchema),
});
export type AlertTypesResponse = z.infer<typeof AlertTypesResponseSchema>;
