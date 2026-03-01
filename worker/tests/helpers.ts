/**
 * Test helpers — mock runner and app factory for API tests.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import Database from "better-sqlite3";
import type { WorkerStatus, WorkerSettingsResponse } from "../src/shared/models/worker.js";
import { migrate } from "../src/db/schema.js";
import { registerRoutes } from "../src/routes/index.js";

export class MockRunner {
  private _running = true;
  private _tickSec = 10;
  private _startTime = performance.now() / 1000;

  get isRunning(): boolean {
    return this._running;
  }

  get uptimeSeconds(): number | null {
    return performance.now() / 1000 - this._startTime;
  }

  get settings(): WorkerSettingsResponse {
    return { tick_interval_sec: this._tickSec };
  }

  updateSettings(tickIntervalSec?: number | null): void {
    if (tickIntervalSec !== undefined && tickIntervalSec !== null) {
      this._tickSec = tickIntervalSec;
    }
  }

  getStatus(
    activeAlerts: number,
    enabledConnections: number,
    credentialsConfigured: boolean,
  ): WorkerStatus {
    return {
      running: this._running,
      status: this._running ? "running" : "stopped",
      last_tick: null,
      last_error: null,
      active_alert_count: activeAlerts,
      enabled_connection_count: enabledConnections,
      tick_interval_sec: this._tickSec,
      uptime_seconds: this.uptimeSeconds,
      credentials_configured: credentialsConfigured,
    };
  }

  async restart(): Promise<void> {
    this._running = true;
  }

  async stop(): Promise<void> {
    this._running = false;
  }

  async start(): Promise<void> {
    this._running = true;
  }
}

export async function createTestApp(): Promise<{
  app: FastifyInstance;
  db: Database.Database;
}> {
  const db = new Database(":memory:");
  migrate(db);

  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Decorate with test DB and mock runner
  app.decorate("db", db);
  app.decorate("runner", new MockRunner() as any);

  // Error handler matching app.ts
  app.setErrorHandler((error: any, _request, reply) => {
    if (error.statusCode) {
      const mapping: Record<number, string> = {
        400: "BAD_REQUEST",
        401: "UNAUTHORIZED",
        403: "FORBIDDEN",
        404: "NOT_FOUND",
        409: "CONFLICT",
        422: "VALIDATION_ERROR",
        500: "INTERNAL_ERROR",
      };
      const code = mapping[error.statusCode] ?? `HTTP_${error.statusCode}`;
      return reply.status(error.statusCode).send({
        error: { code, message: error.message },
      });
    }
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    });
  });

  registerRoutes(app);

  await app.ready();
  return { app, db };
}
