import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSetupTools } from "./setup.js";
import { registerAccountTools } from "./account.js";
import { registerMarketDataTools } from "./market-data.js";
import { registerTradingTools } from "./trading.js";
import { registerMonitorTools } from "./alerts.js";
import { registerConnectorTools } from "./connector.js";
import { registerStrategyTools } from "./strategy.js";

export function registerAllTools(server: McpServer): void {
  registerSetupTools(server);
  registerAccountTools(server);
  registerMarketDataTools(server);
  registerTradingTools(server);
  registerMonitorTools(server);
  registerConnectorTools(server);
  registerStrategyTools(server);
}
