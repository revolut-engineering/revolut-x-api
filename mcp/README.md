# RevolutX MCP Server

MCP (Model Context Protocol) server for the [Revolut X](https://exchange.revolut.com/) crypto exchange. Use natural language in Claude Desktop, Cursor, or any MCP-compatible client to query market data, check balances, view orders, and run grid strategy backtests.

## How It Works

The server runs as a subprocess and communicates via stdin/stdout (STDIO transport). This is the standard mode for all MCP-compatible AI assistants.

```bash
node dist/index.js
```

Configure your MCP client to run:
- **Command:** `node`
- **Args:** `["/path/to/revolut-x-api/mcp/dist/index.js"]`

---

## Installation by Platform

### macOS

**Option A: From source**

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
cd api && npm ci && npm run build && cd ..
cd mcp && npm ci && npm run build
```

**Option B: Claude Desktop (Anthropic directory)**

Search for **RevolutX** in the MCP directory and click Install.

**Option C: Manual — Claude Desktop**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolut-x-api/mcp/dist/index.js"]
    }
  }
}
```

**Option D: Cursor**

Add to Cursor MCP settings or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolut-x-api/mcp/dist/index.js"]
    }
  }
}
```

### Windows

**Option A: From source**

```powershell
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
cd api; npm ci; npm run build; cd ..
cd mcp; npm ci; npm run build
```

**Option B: Claude Desktop**

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["C:\\path\\to\\revolut-x-api\\mcp\\dist\\index.js"]
    }
  }
}
```

### Linux

**Option A: From source**

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
(cd api && npm ci && npm run build)
(cd mcp && npm ci && npm run build)
```

**Option B: Claude Desktop**

Edit `~/.config/Claude/claude_desktop_config.json` (or equivalent):

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolut-x-api/mcp/dist/index.js"]
    }
  }
}
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REVOLUTX_CONFIG_DIR` | `~/.config/revolut-x` | Config directory for API keys |

### First-time setup

After installing, ask your AI assistant:

> "Set up my Revolut X API keys"

This runs `generate_keypair`, `configure_api_key`, and `check_auth_status` in sequence.

---

## Tools

### Setup

| Tool | Description |
|------|-------------|
| `generate_keypair` | Generate a new Ed25519 keypair. Returns the public key to register in your Revolut X account under Profile > API Keys. |
| `configure_api_key` | Save your Revolut X API key after registering the public key. |
| `check_auth_status` | Verify API credentials are configured and working. |
| `get_trading_setup` | Get installation instructions for the `revx` CLI and Claude Code plugin (for placing orders, running grid bots, monitors, etc.). |

### Account

| Tool | Description |
|------|-------------|
| `get_balances` | Get all balances (available, reserved, total) for your Revolut X account. |

### Market Data

| Tool | Description |
|------|-------------|
| `get_currencies` | List all available currencies with name, asset type, precision, and status. |
| `get_currency_pairs` | List all tradeable pairs with step sizes, min/max order sizes, and status. |
| `get_tickers` | Get current bid/ask/mid/last prices. Optionally filter by symbols. |
| `get_order_book` | Get the order book for a pair. `limit` controls depth (1–20, default 20). |
| `get_candles` | Get OHLCV candles. Supports resolutions: `"1m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`, `"4h"`, `"1d"`, `"2d"`, `"4d"`, `"1w"`, `"2w"`, `"4w"`. Auto-paginates when `start_date`/`end_date` are provided. |
| `get_public_trades` | Get public trades for a pair. |

### Orders

| Tool | Description |
|------|-------------|
| `get_active_orders` | Fetch all open orders. Filter by `symbols`, `side`, `order_states` (`pending_new`, `new`, `partially_filled`), `order_types` (`limit`, `conditional`, `tpsl`). Auto-paginates. |
| `get_historical_orders` | Fetch completed orders (`filled`, `cancelled`, `rejected`, `replaced`). Supports date ranges with automatic 7-day chunking. |
| `get_order_by_id` | Get full details of a single order by venue order ID. Shows trigger details for `conditional` and `tpsl` orders. |
| `get_order_fills` | Get all fills (executions) for a specific order. |

### Trades

| Tool | Description |
|------|-------------|
| `get_client_trades` | Get your personal trade history for a pair. Auto-paginates in 7-day chunks when a date range is given. |

---

## Development

```bash
cd mcp
npm install
npm run build      # tsc
npm run dev        # tsx src/index.ts (stdio)
npm test
```

---

## License

MIT — see [LICENSE](../LICENSE) in the repo root.
