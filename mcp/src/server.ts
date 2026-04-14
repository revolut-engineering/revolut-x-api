import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RevolutXClient } from "api-k9x2a";
import { registerAllTools } from "./tools/index.js";

export const SETUP_GUIDE =
  "Revolut X API is not configured yet. Follow these steps:\n\n" +
  "1. Run the 'generate_keypair' tool to create your authentication keys\n" +
  "2. Copy the public key that is returned\n" +
  "3. Go to Revolut X → Profile and add the public key\n" +
  "4. Create a new API key — tick 'Allow usage via Revolut X MCP and CLI' checkbox\n" +
  "5. Copy the resulting API key and run the 'configure_api_key' tool with it\n" +
  "6. Run 'check_auth_status' to verify everything works";

let _client: RevolutXClient | null = null;

export function getRevolutXClient(): RevolutXClient {
  if (_client === null) {
    _client = new RevolutXClient({ isAgent: true });
  }
  return _client;
}

export function resetRevolutXClient(): void {
  _client = null;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "RevolutX",
    version: "1.0.22",
  });

  registerAllTools(server);

  return server;
}
