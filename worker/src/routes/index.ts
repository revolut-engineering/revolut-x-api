import type { FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./health.js";
import { registerAlertRoutes } from "./alerts.js";
import { registerTelegramRoutes } from "./telegram.js";
import { registerEventRoutes } from "./events.js";
import { registerWorkerRoutes } from "./worker-ops.js";
import { registerPairsRoutes } from "./pairs.js";

export function registerRoutes(app: FastifyInstance): void {
  registerHealthRoutes(app);
  registerAlertRoutes(app);
  registerTelegramRoutes(app);
  registerEventRoutes(app);
  registerWorkerRoutes(app);
  registerPairsRoutes(app);
}
