import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInstructionsTools } from "./instructions.js";
import { registerSetupTools } from "./setup.js";
import { registerAccountTools } from "./account.js";
import { registerMarketDataTools } from "./market-data.js";
import { registerTradingTools } from "./trading.js";
import { registerMonitorTools } from "./alerts.js";
import { registerStrategyTools } from "./strategy.js";
import { registerBacktestTools } from "./backtest.js";
import { registerConnectorTools } from "./connector.js";

export function registerAllTools(server: McpServer): void {
  registerInstructionsTools(server);
  registerSetupTools(server);
  registerAccountTools(server);
  registerMarketDataTools(server);
  registerTradingTools(server);
  registerMonitorTools(server);
  registerStrategyTools(server);
  registerBacktestTools(server);
  registerConnectorTools(server);
}
