import type Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpToAnthropicTools } from "./mcp-to-anthropic.js";
import type {
  AgentResult,
  RunAgentOptions,
  ToolCall,
  UsageTotals,
} from "./types.js";

export const DEFAULT_MODEL = "claude-opus-4-7";
export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_MAX_TOKENS = 4096;

interface RunAgentDeps {
  anthropic: Anthropic;
  mcpClient: Client;
}

export async function runAgent(
  opts: RunAgentOptions & RunAgentDeps,
): Promise<AgentResult> {
  const {
    anthropic,
    mcpClient,
    prompt,
    systemPrompt,
    model = DEFAULT_MODEL,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature,
  } = opts;

  const tools = await mcpToAnthropicTools(mcpClient);
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];
  const toolCalls: ToolCall[] = [];
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0 };
  const startedAt = Date.now();

  for (let turn = 0; turn < maxIterations; turn++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      tools,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(systemPrompt ? { system: systemPrompt } : {}),
    });

    accumulateUsage(usage, response.usage);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      return finalize(
        toolCalls,
        response.content,
        turn + 1,
        response.stop_reason,
        startedAt,
        usage,
        model,
      );
    }

    if (response.stop_reason !== "tool_use") {
      return finalize(
        toolCalls,
        response.content,
        turn + 1,
        response.stop_reason ?? "unknown",
        startedAt,
        usage,
        model,
      );
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const args = (block.input ?? {}) as Record<string, unknown>;
      const callResult = (await mcpClient.callTool({
        name: block.name,
        arguments: args,
      })) as CallToolResult;

      toolCalls.push({
        name: block.name,
        args,
        result: callResult,
        turn,
      });

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: extractMcpResultText(callResult),
        is_error: callResult.isError === true,
      });
    }

    messages.push({ role: "user", content: toolResultBlocks });
  }

  throw new Error(
    `Agent exceeded max iterations (${maxIterations}). Tool calls so far: ${toolCalls
      .map((c) => c.name)
      .join(", ")}`,
  );
}

function accumulateUsage(
  acc: UsageTotals,
  responseUsage: Anthropic.Usage,
): void {
  acc.inputTokens += responseUsage.input_tokens ?? 0;
  acc.outputTokens += responseUsage.output_tokens ?? 0;
  if (responseUsage.cache_creation_input_tokens) {
    acc.cacheCreationInputTokens =
      (acc.cacheCreationInputTokens ?? 0) +
      responseUsage.cache_creation_input_tokens;
  }
  if (responseUsage.cache_read_input_tokens) {
    acc.cacheReadInputTokens =
      (acc.cacheReadInputTokens ?? 0) + responseUsage.cache_read_input_tokens;
  }
}

function finalize(
  toolCalls: ToolCall[],
  content: Anthropic.ContentBlock[],
  turns: number,
  stopReason: string,
  startedAt: number,
  usage: UsageTotals,
  model: string,
): AgentResult {
  return {
    toolCalls,
    finalText: extractText(content),
    turns,
    stopReason,
    durationMs: Date.now() - startedAt,
    usage,
    model,
  };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractMcpResultText(result: CallToolResult): string {
  if (!result.content) return "";
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
