import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSetupTools } from "./setup.js";
import { registerAccountTools } from "./account.js";
import { registerMarketDataTools } from "./market-data.js";
import { registerTradingTools } from "./trading.js";
import { registerBacktestTools } from "./backtest.js";
import { registerAlertTools } from "./alerts.js";
import { registerTelegramTools } from "./telegram.js";
import { registerWorkerTools } from "./worker-ops.js";
import { registerEventTools } from "./events.js";

export function registerAllTools(server: McpServer): void {
  registerSetupTools(server);
  registerAccountTools(server);
  registerMarketDataTools(server);
  registerTradingTools(server);
  registerBacktestTools(server);
  registerAlertTools(server);
  registerTelegramTools(server);
  registerWorkerTools(server);
  registerEventTools(server);
}
