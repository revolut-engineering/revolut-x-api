# RevolutX MCP Server

MCP server for the [Revolut X](https://exchange.revolut.com/) crypto exchange. Query market data, check account balances, view order books, analyze candlestick charts, and run grid trading backtests — all through natural language in Claude Desktop, Claude Code, or any MCP-compatible client.

Built on the [Revolut X Exchange REST API](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api), this server exposes 35 MCP tools covering market data retrieval, account management, technical analysis, alert monitoring, and automated strategy backtesting.

## Features

- **Market data** — live tickers, order books, OHLCV candles, public trades for all Revolut X pairs
- **Account management** — check balances across all held cryptocurrencies and fiat currencies
- **Grid trading backtests** — simulate grid strategies on historical data, optimize parameters, analyze P&L
- **Technical analysis alerts** — 10 indicator types (price, RSI, MACD, EMA cross, Bollinger Bands, ATR breakout, volume spike, spread, OBI, price change %)
- **Telegram notifications** — get notified when alert conditions trigger
- **Background Worker** — monitors markets 24/7 independently of any active AI session
- **Zero-install** — ships as a Node.js MCP server, runs locally on your machine

## Installation

### From Anthropic Directory

Search for **RevolutX** in the Claude Desktop MCP directory and click Install.

### Manual Setup — Claude Desktop

Add to your Claude Desktop configuration file:

**macOS:** `~/Library/Application\ Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolutx-ai/mcp/dist/index.js"]
    }
  }
}
```

### Manual Setup — Claude Code

```bash
claude mcp add revolutx node /path/to/revolutx-ai/mcp/dist/index.js
```

### Build from Source

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api/mcp
npm install
npm run build:bundle   # produces dist/index.js
```

## Configuration

### First-time API key setup

After installing the server, ask Claude to set up your credentials:

> "Set up my Revolut X API keys"

This runs three tools in sequence:

1. **`generate_keypair`** — creates an Ed25519 keypair in your local config directory
2. You copy the public key to your Revolut X account (Profile > API Keys) and get an API key back
3. **`configure_api_key`** — saves the API key locally
4. **`check_auth_status`** — verifies the connection works

All credentials are stored locally on your machine. The private key never leaves your filesystem.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REVOLUTX_CONFIG_DIR` | Platform-dependent (see below) | Config directory path |
| `REVOLUTX_WORKER_URL` | `http://localhost:8080` | Worker service URL (for alerts/Telegram) |

**Default config directory:**

| Platform | Path |
|----------|------|
| macOS | `~/.config/revolutx-mcp/` |
| Windows | `%APPDATA%\revolutx-mcp\` |
| Linux | `~/.config/revolutx-mcp/` |

## Usage Examples

### 1. Set up API authentication

> "Set up my Revolut X API keys"

**Tools called:** `generate_keypair` > `configure_api_key` > `check_auth_status`

```
Ed25519 keypair generated successfully!

Here is your PUBLIC key (copy this):

-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----

Next steps:
1. Copy the public key above
2. Go to your Revolut X account > Profile > API Keys
3. Add this public key and create a new API key
4. Copy the API key that Revolut X gives you
5. Run 'configure_api_key' with that API key
```

After providing the API key:

```
API key saved successfully!
Authentication is configured and working!
Successfully connected to Revolut X API.
Available currencies: 48
```

### 2. Check portfolio balances

> "What are my Revolut X balances?"

**Tool called:** `get_balances`

```
  Currency |        Available |       Reserved |            Total
-----------------------------------------------------------------
       BTC |       0.12345678 |     0.00000000 |       0.12345678
       ETH |       2.50000000 |     0.50000000 |       3.00000000
       USD |        5432.10   |        0.00    |        5432.10
      USDT |       1000.00    |        0.00    |        1000.00
```

### 3. Get live market prices

> "Show me current prices for BTC and ETH"

**Tool called:** `get_tickers`

```
Pair         |            Bid |            Ask |            Mid |           Last
------------------------------------------------------------------------------
BTC-USD      |   97234.50     |   97238.20     |   97236.35     |   97235.00
ETH-USD      |    3412.80     |    3413.50     |    3413.15     |    3413.00
SOL-USD      |     178.42     |     178.58     |     178.50     |     178.45
```

### 4. View order book depth

> "Show me the order book for BTC-USD"

**Tool called:** `get_order_book` with `symbol: "BTC-USD"`, `limit: 20`

```
Order Book: BTC-USD

                       ASKS (Sell)
         Price Currency |       Quantity   Unit | Orders
----------------------------------------------------------
      97250.00      USD |       0.15000    BTC |      3
      97245.00      USD |       0.08500    BTC |      2
      97240.00      USD |       0.22000    BTC |      5
      97238.20      USD |       0.05000    BTC |      1

                       BIDS (Buy)
         Price Currency |       Quantity   Unit | Orders
----------------------------------------------------------
      97234.50      USD |       0.10000    BTC |      2
      97230.00      USD |       0.18000    BTC |      4
      97225.00      USD |       0.25000    BTC |      3
      97220.00      USD |       0.12000    BTC |      2
```

### 5. Analyze candlestick data

> "Get the last 24 hours of 1-hour candles for ETH-USD"

**Tool called:** `get_candles` with `symbol: "ETH-USD"`, `resolution: "1h"`, `limit: 24`

```
Candles for ETH-USD (1h):

Start                |         Open |         High |          Low |        Close |         Volume
-----------------------------------------------------------------------------------------------
2026-02-28T00:00:00  |      3380.50 |      3395.20 |      3378.00 |      3392.40 |        1245.80
2026-02-28T01:00:00  |      3392.40 |      3410.00 |      3388.50 |      3408.75 |         987.30
2026-02-28T02:00:00  |      3408.75 |      3415.60 |      3400.10 |      3413.00 |         856.20
...
```

### 6. Run a grid trading backtest

> "Backtest a grid strategy on BTC-USD with 10 levels and 5% range"

**Tool called:** `grid_backtest` with `symbol: "BTC-USD"`, `grid_levels: 10`, `range_pct: "5"`, `investment: "1000"`, `resolution: "1h"`

```
Grid Backtest Results for BTC-USD
==================================================
Data: 100 candles (1h resolution)
Price range: $95120.00 - $98450.00
Start price: $97235.00
Grid range: $92373.25 - $102096.75 (5.0%)
Grid levels: 10 | Buy levels: 5 | USD/level: $200.00
Fee rate: 0.00%

Performance
--------------------------------------------------
Total trades: 14 (7 buys, 7 sells)
Total fees: $0.00
Realized P&L: $42.35
Final USD: $1042.35
Final BTC: 0.00000 (~$0.00)
Total portfolio: $1042.35
Net return: $42.35 (4.24%)
Max drawdown: 1.82%
```

## Privacy Policy

RevolutX MCP Server is a **local-only** application. All data stays on your machine.

- **Data collected:** Revolut X API key and Ed25519 private key, stored in your local config directory with restricted file permissions (0600). Optionally, Telegram bot tokens for alert notifications.
- **Data storage:** All data is stored locally — credentials in JSON config files, alerts and events in a local SQLite database. No cloud storage is used.
- **Data sharing:** API credentials are sent only to `revx.revolut.com` (Revolut X Exchange API) for authenticated requests. Telegram bot tokens are sent only to `api.telegram.org` when notifications are configured. **No data is sent to Anthropic, the developer, or any third party.**
- **Data retention:** All data persists locally until you delete it. Remove the config directory to delete all stored data.
- **Third-party services:** Revolut X Exchange API (market data, account operations), Telegram Bot API (optional notifications).
- **Contact:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)

For the full privacy policy, see [PRIVACY.md](https://github.com/revolut-engineering/revolut-x-api/blob/main/PRIVACY.md).

## Support

- **Issues & Bug Reports:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)
- **Revolut X API Docs:** [developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api)

## License

MIT — see [LICENSE](LICENSE)
