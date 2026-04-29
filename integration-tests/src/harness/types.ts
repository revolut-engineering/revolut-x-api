import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: CallToolResult;
  turn: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface AgentResult {
  toolCalls: ToolCall[];
  finalText: string;
  turns: number;
  stopReason: string;
  durationMs: number;
  usage: UsageTotals;
  model: string;
}

export interface RunAgentOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
}
