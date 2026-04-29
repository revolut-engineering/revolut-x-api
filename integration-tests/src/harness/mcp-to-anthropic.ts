import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type Anthropic from "@anthropic-ai/sdk";

export async function mcpToAnthropicTools(
  mcpClient: Client,
): Promise<Anthropic.Tool[]> {
  const { tools } = await mcpClient.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}
