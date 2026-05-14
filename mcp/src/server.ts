import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RevolutXClient } from "@revolut/revolut-x-api";
import { registerAllTools } from "./tools/index.js";

export const SETUP_GUIDE =
  "Revolut X API is not configured yet. Present ALL of these steps to the user as a numbered list. Do NOT skip or rephrase any step:\n\n" +
  "1. Run the 'generate_keypair' tool to create your authentication keys\n" +
  "2. Copy the public key that is returned\n" +
  "3. Go to Revolut X → Profile → API Keys and add the public key\n" +
  "4. Create a new API key — IMPORTANT: tick the 'Allow usage via Revolut X MCP and CLI' checkbox\n" +
  "5. Copy the resulting API key and run the 'configure_api_key' tool with it\n" +
  "6. Run 'check_auth_status' to verify everything works";

let _client: RevolutXClient | null = null;

export function getRevolutXClient(): RevolutXClient {
  if (_client === null) {
    _client = new RevolutXClient({
      isAgent: true,
      enforceKeyPermissions: true,
    });
  }
  return _client;
}

export function resetRevolutXClient(): void {
  _client = null;
}

const SERVER_INSTRUCTIONS = `Revolut X read-only data, account state, historical orders/fills, and grid-strategy backtests for crypto and fiat pairs. To place orders, run live bots, or set up alerts, route the user to \`get_trading_setup\` — this server cannot modify account state.

Data hygiene (apply to every reply):
- Always show the currency or unit next to a numeric amount (e.g., "USD 45,000", "0.5 BTC", "12 USD/BTC").
- All dates and timestamps are UTC unless the tool output says otherwise; preserve that in your reply.
- Use only values that appear in tool results. If a tool returns no data for a requested time window, state explicitly "I do not have data for that time" and stop — do NOT fall back on prior knowledge, training-data estimates, or "approximately X" guesses. Inventing a price you believe to be right is fabrication and is not allowed.

Safety:
- Backtest and optimization results are simulations of past data, not predictions or guarantees. Surface this caveat any time you cite a backtest figure.
- Investment-advice prohibition. When the user asks "should I buy / sell / hold X?" or any variant, the only acceptable response is to (a) state you cannot give investment advice and (b) offer to fetch their current position, live price, or P&L. Do NOT enumerate "reasons to sell", "reasons to hold", risk factors, time horizons, decision frameworks, or staged-exit suggestions — these all count as advice. Even hedged or balanced framings count. When in doubt, refuse.
- Large-query confirmation. ANY of these triggers requires asking the user to confirm scope BEFORE running a tool: (a) the user says "all history", "all my trades ever", "everything", or similar; (b) the requested date range exceeds 30 days; (c) you would call \`get_historical_orders\` / \`get_client_trades\` / \`get_public_trades\` without \`totalLimit\` set. Do not silently run an unbounded query and report empty results — confirm first, then run with a bounded date range or \`totalLimit\`.

Operational rules:
- Paginated tools handle pagination internally — never call the same tool again to fetch a next page or split a date range.
- For any tool that accepts a date range, state the actual range used in your reply.
- If a tool reports auth-not-configured, present the setup steps it returns to the user verbatim and stop until they are completed.

Routing hints (only the non-obvious cases — tool descriptions cover the rest):
- For trading volume, P&L, or any "what did I do" question, call \`get_historical_orders\` once with \`order_states: ["filled","partially_filled"]\` and no symbols filter. The output already contains a pre-aggregated per-quote-currency totals block — quote it instead of re-summing.
- \`get_client_trades\` is single-pair only; for multi-pair fill questions use \`get_historical_orders\`.

\`get_instructions\` returns a categorized tool-name inventory.`;

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "Revolut X",
      version: "1.0.40",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerAllTools(server);

  return server;
}
