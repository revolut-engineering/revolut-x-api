import type { FastifyInstance } from "fastify";
import { isConfigured } from "../shared/settings.js";
import { AlertRepo, TelegramConnectionRepo } from "../db/repositories.js";

const startTime = performance.now() / 1000;

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async (_request, _reply) => {
    const activeAlerts = AlertRepo.count(app.db, { enabled: true });
    const enabledConnections = TelegramConnectionRepo.listEnabled(app.db).length;
    const uptime = performance.now() / 1000 - startTime;
    const status = app.runner.isRunning ? "healthy" : "degraded";

    return {
      status,
      version: "0.1.0",
      worker_running: app.runner.isRunning,
      uptime_seconds: uptime,
      active_alerts: activeAlerts,
      enabled_connections: enabledConnections,
      credentials_configured: isConfigured(),
    };
  });
}
