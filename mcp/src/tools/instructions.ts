import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./_helpers.js";

const INSTRUCTIONS_TEXT = `[CRITICAL RULES — MANDATORY FOR ALL SESSIONS]

RULE 1 — VERIFY BEFORE ASSUMING
Never assume a tool or \`revx\` CLI command exists. Before referencing any
tool name or subcommand, call get_instructions (once per session) or rely
on what get_instructions returned to confirm availability. Tool names and
CLI subcommands may change between versions.

RULE 2 — NEVER PLACE ORDERS ON BEHALF OF THE USER
Do NOT call tools that place, modify, or cancel orders autonomously.
Use order_command / strategy_command / monitor_command / connector_command
to generate CLI commands, then RECOMMEND that command to the user.
Let the user run it themselves. This applies to:
  - order_command (place_market, place_limit, cancel, cancel_all)
  - strategy_command with action=run (live grid trading)
  - monitor_command (starts live monitoring process)
  - connector_command (configures notification subscriptions)

[TOOL OVERVIEW]

Setup (safe to call):
  generate_keypair      — create Ed25519 keypair for API auth
  configure_api_key     — save your API key
  check_auth_status     — verify connection

Read-only data (safe to call):
  get_balances          — all crypto balances
  get_currencies        — all available currencies
  get_currency_pairs    — all tradeable pairs
  get_tickers           — current bid/ask/last prices
  get_order_book        — live order book depth
  get_candles           — OHLCV candlestick history
  get_active_orders     — open orders
  get_historical_orders — completed/cancelled orders
  get_order_by_id       — single order detail
  get_order_fills       — fill details for an order
  get_client_trades     — personal trade history
  grid_backtest         — run backtest simulation
  grid_optimize         — optimize grid parameters
  grid_status           — read saved bot state
  grid_states_list      — list saved bot states
  monitor_types         — list supported alert types

CLI Command Generators (⚠ return commands for USER to run — do NOT run autonomously):
  order_command         — place_market / place_limit / cancel / cancel_all
  strategy_command      — backtest / optimize / run grid
  monitor_command       — start a price/condition alert
  connector_command     — Telegram notification setup

Instructions:
  get_instructions      — this document (call once per session)`;

export function registerInstructionsTools(server: McpServer): void {
  server.registerTool(
    "get_instructions",
    {
      title: "Get RevolutX MCP Instructions",
      description:
        "CALL THIS FIRST. Returns mandatory usage rules and tool overview for this MCP. " +
        "RULE 1: Never assume any tool or CLI command exists — verify via get_instructions before referencing any tool name or `revx` subcommand. " +
        "RULE 2: Never call order-placing tools autonomously — use order_command / strategy_command / monitor_command / connector_command to generate CLI commands, then present them to the user to run.",
      annotations: {
        title: "Get RevolutX MCP Instructions",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    () => textResult(INSTRUCTIONS_TEXT),
  );
}
