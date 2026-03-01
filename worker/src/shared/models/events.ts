import { z } from "zod";

export const EventResponseSchema = z.object({
  id: z.string(),
  ts: z.string().datetime(),
  category: z.string(),
  details: z.record(z.unknown()),
});
export type EventResponse = z.infer<typeof EventResponseSchema>;

export const EventListResponseSchema = z.object({
  data: z.array(EventResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type EventListResponse = z.infer<typeof EventListResponseSchema>;
