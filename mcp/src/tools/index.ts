import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSetupTools } from "./setup.js";
import { registerAccountTools } from "./account.js";
import { registerMarketDataTools } from "./market-data.js";
import { registerTradingTools } from "./trading.js";
import { registerBacktestTools } from "./backtest.js";
import { registerMonitorTools } from "./alerts.js";
import { registerTelegramTools } from "./telegram.js";

export function registerAllTools(server: McpServer): void {
  registerSetupTools(server);
  registerAccountTools(server);
  registerMarketDataTools(server);
  registerTradingTools(server);
  registerBacktestTools(server);
  registerMonitorTools(server);
  registerTelegramTools(server);
}
