/**
 * RevolutX MCP server entry point — STDIO or HTTP transport.
 *
 * IMPORTANT: Never use console.log() — STDIO transport uses stdout for JSON-RPC.
 * Use console.error() for diagnostics.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
