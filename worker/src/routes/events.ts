import type { FastifyInstance, FastifyRequest } from "fastify";
import { EventRepo } from "../db/repositories.js";

function parseDatetime(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function rowToEventResponse(row: Record<string, unknown>) {
  const detailsRaw = row.details_json as string | null;
  const details = detailsRaw ? JSON.parse(detailsRaw) : {};

  return {
    id: row.id,
    ts: parseDatetime(row.ts),
    category: row.category,
    details,
  };
}

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/api/events", async (request: FastifyRequest) => {
    const query = request.query as Record<string, string>;
    const category = query.category;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const rows = EventRepo.listRecent(app.db, { category, limit, offset });
    const total = EventRepo.count(app.db, category);

    return {
      data: rows.map(rowToEventResponse),
      total,
      limit,
      offset,
    };
  });
}
