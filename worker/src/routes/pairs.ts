import type { FastifyInstance, FastifyReply } from "fastify";
import { loadCredentials } from "../shared/auth/credentials.js";
import { fetchPairsFromApi } from "./alerts.js";

export function registerPairsRoutes(app: FastifyInstance): void {
  app.get("/api/pairs", async (_request, reply: FastifyReply) => {
    const creds = loadCredentials();
    if (creds === null) {
      return reply.status(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Credentials not configured. Set up API keys first.",
        },
      });
    }

    const pairs = await fetchPairsFromApi(creds);
    if (pairs === null) {
      return reply.status(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Failed to fetch pairs from Revolut X API.",
        },
      });
    }

    return { pairs: [...pairs].sort() };
  });
}
