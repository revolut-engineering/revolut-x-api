import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ConnectionCreateSchema, ConnectionUpdateSchema, TestConnectionRequestSchema } from "../shared/models/telegram.js";
import { redactToken, sendMessage } from "../shared/notify/telegram.js";
import { TelegramConnectionRepo } from "../db/repositories.js";

function parseDatetime(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function rowToConnectionResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    label: row.label,
    bot_token_redacted: redactToken(String(row.bot_token)),
    chat_id: row.chat_id,
    enabled: Boolean(row.enabled),
    last_tested_at: parseDatetime(row.last_tested_at),
    last_test_error: (row.last_test_error as string | null) ?? null,
    created_at: parseDatetime(row.created_at),
    updated_at: parseDatetime(row.updated_at),
  };
}

export function registerTelegramRoutes(app: FastifyInstance): void {
  app.get("/api/telegram/connections", async (request: FastifyRequest) => {
    const query = request.query as Record<string, string>;
    const enabled = query.enabled !== undefined
      ? query.enabled === "true"
      : undefined;

    const rows = TelegramConnectionRepo.listAll(app.db, enabled);
    return {
      data: rows.map(rowToConnectionResponse),
      total: rows.length,
    };
  });

  app.post("/api/telegram/connections", async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = ConnectionCreateSchema.safeParse(request.body);
    if (!parseResult.success) {
      const details = parseResult.error.errors.map((e) => ({
        loc: e.path,
        msg: e.message,
        type: e.code,
      }));
      return reply.status(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: details[0]?.msg ?? "Validation failed",
          details,
        },
      });
    }

    const body = parseResult.data;
    const raw = TelegramConnectionRepo.create(
      app.db,
      body.label,
      body.bot_token,
      body.chat_id,
    );

    let testResult = null;
    if (body.test) {
      const msg = "RevolutX: Connection test successful!";
      const result = await sendMessage(body.bot_token, body.chat_id, msg);
      testResult = { success: result.success, error: result.error ?? null };
      TelegramConnectionRepo.updateTestResult(
        app.db,
        raw.id as string,
        result.success,
        result.error,
      );
    }

    // Refresh to get updated test fields
    const row = TelegramConnectionRepo.get(app.db, raw.id as string) ?? raw;
    const response = rowToConnectionResponse(row);
    return reply.status(201).send({
      ...response,
      test_result: testResult,
    });
  });

  app.patch("/api/telegram/connections/:connId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connId } = request.params as { connId: string };

    const parseResult = ConnectionUpdateSchema.safeParse(request.body);
    if (!parseResult.success) {
      const details = parseResult.error.errors.map((e) => ({
        loc: e.path,
        msg: e.message,
        type: e.code,
      }));
      return reply.status(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: details[0]?.msg ?? "Validation failed",
          details,
        },
      });
    }

    const body = parseResult.data;
    const updates: Record<string, unknown> = {};

    if (body.enabled !== undefined && body.enabled !== null) {
      updates.enabled = body.enabled ? 1 : 0;
    }
    if (body.label !== undefined && body.label !== null) {
      updates.label = body.label;
    }

    if (Object.keys(updates).length > 0) {
      const found = TelegramConnectionRepo.update(app.db, connId, updates);
      if (!found) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: `Connection '${connId}' not found` },
        });
      }
    } else {
      if (!TelegramConnectionRepo.get(app.db, connId)) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: `Connection '${connId}' not found` },
        });
      }
    }

    const row = TelegramConnectionRepo.get(app.db, connId)!;
    return rowToConnectionResponse(row);
  });

  app.delete("/api/telegram/connections/:connId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connId } = request.params as { connId: string };
    const found = TelegramConnectionRepo.delete(app.db, connId);
    if (!found) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `Connection '${connId}' not found` },
      });
    }
    return reply.status(204).send();
  });

  app.post("/api/telegram/connections/:connId/test", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connId } = request.params as { connId: string };
    const row = TelegramConnectionRepo.get(app.db, connId);
    if (!row) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `Connection '${connId}' not found` },
      });
    }

    const parseResult = TestConnectionRequestSchema.safeParse(request.body ?? {});
    const body = parseResult.success ? parseResult.data : { message: "" };
    const msg = body.message || "RevolutX: Connection test";

    const result = await sendMessage(
      String(row.bot_token),
      String(row.chat_id),
      msg,
    );
    TelegramConnectionRepo.updateTestResult(
      app.db,
      connId,
      result.success,
      result.error,
    );

    return { success: result.success, error: result.error ?? null };
  });
}
