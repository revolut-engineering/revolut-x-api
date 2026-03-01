import { z } from "zod";

export const WorkerStatusSchema = z.object({
  running: z.boolean(),
  status: z.enum(["running", "stopped", "error"]),
  last_tick: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
  active_alert_count: z.number().int(),
  enabled_connection_count: z.number().int(),
  tick_interval_sec: z.number().int(),
  uptime_seconds: z.number().nullable(),
  credentials_configured: z.boolean(),
});
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const WorkerControlResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
});
export type WorkerControlResponse = z.infer<typeof WorkerControlResponseSchema>;

export const WorkerSettingsResponseSchema = z.object({
  tick_interval_sec: z.number().int(),
});
export type WorkerSettingsResponse = z.infer<typeof WorkerSettingsResponseSchema>;

export const WorkerSettingsUpdateSchema = z.object({
  tick_interval_sec: z.number().int().min(1).max(300).nullable().optional(),
});
export type WorkerSettingsUpdate = z.infer<typeof WorkerSettingsUpdateSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  version: z.string(),
  worker_running: z.boolean(),
  uptime_seconds: z.number(),
  active_alerts: z.number().int(),
  enabled_connections: z.number().int(),
  credentials_configured: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
