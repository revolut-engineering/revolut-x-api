export interface WorkerSettings {
  host: string;
  port: number;
  tickSec: number;
  logLevel: string;
  corsOrigins: string[];
}

export function loadSettings(): WorkerSettings {
  return {
    host: process.env["REVOLUTX_WORKER_HOST"] ?? "127.0.0.1",
    port: Number(process.env["REVOLUTX_WORKER_PORT"] ?? "8080"),
    tickSec: Number(process.env["REVOLUTX_WORKER_TICK_SEC"] ?? "10"),
    logLevel: (process.env["LOG_LEVEL"] ?? "info").toLowerCase(),
    corsOrigins: (
      process.env["REVOLUTX_CORS_ORIGINS"] ??
      "http://localhost:3000,http://localhost:5173"
    )
      .split(",")
      .map((o) => o.trim()),
  };
}
