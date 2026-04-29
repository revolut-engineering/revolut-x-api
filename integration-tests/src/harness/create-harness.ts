import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, resetRevolutXClient } from "../../../mcp/src/server.js";
import { runAgent } from "./run-agent.js";
import { resetRevolutXMockState } from "./revolut-x-mock.js";
import type { AgentResult, RunAgentOptions } from "./types.js";

export interface Harness {
  mcpClient: Client;
  anthropic: Anthropic;
  runAgent(opts: RunAgentOptions): Promise<AgentResult>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  resetRevolutXMockState();
  resetRevolutXClient();

  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const mcpClient = new Client({
    name: "revolutx-agent-test",
    version: "0.0.1",
  });
  await mcpClient.connect(clientTransport);

  const anthropic = new Anthropic();

  return {
    mcpClient,
    anthropic,
    runAgent: (opts) => runAgent({ ...opts, mcpClient, anthropic }),
    async close() {
      await mcpClient.close();
      await server.close();
    },
  };
}
