import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstructionsTools } from "./instructions.js";
import { registerSetupTools } from "./setup.js";
import { registerAccountTools } from "./account.js";
import { registerMarketDataTools } from "./market-data.js";
import { registerTradingTools } from "./trading.js";
import { registerBacktestTools } from "./backtest.js";

export function registerAllTools(server: McpServer): void {
  registerInstructionsTools(server);
  registerSetupTools(server);
  registerAccountTools(server);
  registerMarketDataTools(server);
  registerTradingTools(server);
  registerBacktestTools(server);
}
