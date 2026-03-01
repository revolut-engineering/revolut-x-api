/**
 * MCP server setup — singleton clients and server factory.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RevolutXClient } from "./shared/client/api-client.js";
import { RateLimiter } from "./shared/client/rate-limiter.js";
import { WorkerAPIClient } from "./shared/client/worker-client.js";
import { loadCredentials } from "./shared/auth/credentials.js";
import { registerAllTools } from "./tools/index.js";

let _client: RevolutXClient | null = null;
let _workerClient: WorkerAPIClient | null = null;

export function getRevolutXClient(): RevolutXClient {
  if (_client === null) {
    const creds = loadCredentials();
    const rateLimiter = new RateLimiter();
    _client = new RevolutXClient({
      rateLimiter,
      credentials: creds ?? undefined,
    });
  }
  return _client;
}

export function getWorkerClient(): WorkerAPIClient {
  if (_workerClient === null) {
    const workerUrl =
      process.env["REVOLUTX_WORKER_URL"] ?? "http://localhost:8080";
    _workerClient = new WorkerAPIClient(workerUrl);
  }
  return _workerClient;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "RevolutX",
    version: "0.2.0",
  });

  registerAllTools(server);

  return server;
}
