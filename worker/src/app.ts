/**
 * Fastify application factory with lifecycle management.
 */
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import type Database from "better-sqlite3";
import { ZodError } from "zod";

import type { WorkerSettings } from "./config.js";
import { createDatabase } from "./db/connection.js";
import { migrate } from "./db/schema.js";
import { WorkerRunner } from "./engine/runner.js";
import { registerRoutes } from "./routes/index.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database.Database;
    runner: WorkerRunner;
  }
}

const startTime = performance.now() / 1000;

export async function buildApp(settings: WorkerSettings): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: settings.logLevel,
    },
    ignoreTrailingSlash: true,
  });

  // CORS
  await app.register(cors, {
    origin: settings.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  // Database
  const db = createDatabase();
  migrate(db);
  app.decorate("db", db);

  // Runner
  const runner = new WorkerRunner(settings.tickSec);
  app.decorate("runner", runner);

  // Lifecycle hooks
  app.addHook("onReady", async () => {
    await runner.start();
  });

  app.addHook("onClose", async () => {
    await runner.stop();
    db.close();
  });

  // Error handler
  app.setErrorHandler(
    (error: Error & { statusCode?: number; validation?: unknown }, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ZodError) {
        const details = error.errors.map((e) => ({
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

      if (error.statusCode) {
        const code = statusToCode(error.statusCode);
        return reply.status(error.statusCode).send({
          error: {
            code,
            message: error.message,
          },
        });
      }

      return reply.status(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      });
    },
  );

  // Routes
  registerRoutes(app);

  return app;
}

function statusToCode(statusCode: number): string {
  const mapping: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    500: "INTERNAL_ERROR",
  };
  return mapping[statusCode] ?? `HTTP_${statusCode}`;
}
