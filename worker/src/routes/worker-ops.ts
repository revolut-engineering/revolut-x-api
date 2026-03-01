import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { WorkerSettingsUpdateSchema } from "../shared/models/worker.js";
import { isConfigured } from "../shared/settings.js";
import { AlertRepo, TelegramConnectionRepo } from "../db/repositories.js";

export function registerWorkerRoutes(app: FastifyInstance): void {
  app.get("/api/worker/status", async () => {
    const activeAlerts = AlertRepo.count(app.db, { enabled: true });
    const enabledConnections = TelegramConnectionRepo.listEnabled(app.db).length;
    return app.runner.getStatus(activeAlerts, enabledConnections, isConfigured());
  });

  app.post("/api/worker/restart", async () => {
    await app.runner.restart();
    return { status: "ok", message: "Worker restarted" };
  });

  app.post("/api/worker/stop", async () => {
    await app.runner.stop();
    return { status: "ok", message: "Worker stopped" };
  });

  app.get("/api/worker/settings", async () => {
    return app.runner.settings;
  });

  app.patch("/api/worker/settings", async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = WorkerSettingsUpdateSchema.safeParse(request.body);
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
    app.runner.updateSettings(body.tick_interval_sec);
    return app.runner.settings;
  });
}
