# revolut-x-api

Monorepo for open-source tooling around the [Revolut X](https://exchange.revolut.com/) crypto exchange.

## Packages

| Package | Description                                                                                                                                                                           |
|---------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`api/`](api/) | Typed HTTP client for the Revolut X REST API. Zero runtime dependencies — Node.js built-ins only.                                                                                     |
| [`mcp/`](mcp/) | MCP server exposing tools for market data, account management, orders, monitoring, and grid strategy backtests. Use with Claude Desktop, Claude Code, or any MCP-compatible client. |
| [`cli/`](cli/) | `revx` command-line interface for trading, monitoring, and running grid bots from the terminal.                                                                                       |
| [`skills/`](skills/) | Claude Code skills —  focused `revx` CLI command references (auth, market, account, trading, monitor, telegram, strategy).                                                            |

---

## Quick Start

### MCP Server (Claude Desktop / Claude Code)

Build both the API and MCP packages:

**Production** (default, targets `https://revx.revolut.com`):

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
npm ci
npm run build -w api
npm run build -w mcp
```

**Development** (targets `https://revx.revolut.codes`):

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
npm ci
cd api && npm run build:dev && cd ..
npm run build -w mcp
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

**Claude Code:**

```bash
claude mcp add revolutx node /path/to/revolut-x-api/mcp/dist/index.js
```

Then ask Claude: **"Set up my Revolut X API keys"** to complete authentication.

### CLI

**Production** (default, targets `https://revx.revolut.com`):

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
npm ci
npm run build -w api
npm run build -w cli
npm link -w cli
```

**Development** (targets `https://revx.revolut.codes`):

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
npm ci
cd api && npm run build:dev && cd ..
npm run build -w cli
npm link -w cli
```

```bash
# Setup
revx configure                                              # Set up API key and private key

# Account
revx account balances                                       # Show non-zero balances
revx account balances BTC                                   # Get BTC balance
revx account balances --currencies BTC,ETH,USD              # Filter by currencies
revx account balances --all                                 # Include zero balances

# Market
revx market currencies                                      # List supported currencies
revx market currencies fiat                                 # Filter fiat only
revx market currencies crypto                               # Filter crypto only
revx market pairs                                           # List all trading pairs
revx market pairs BTC-USD                                   # Get BTC-USD pair info
revx market tickers                                         # List all tickers
revx market tickers --symbols BTC-USD,ETH-USD               # Filter tickers by pair
revx market ticker BTC-USD                                  # Get BTC-USD ticker
revx market candles BTC-USD                                 # Get hourly candles
revx market candles BTC-USD --interval 5m                   # Get 5-minute candles
revx market candles BTC-USD --since 7d --until today
revx market orderbook BTC-USD                               # Get order book (top 10)
revx market orderbook BTC-USD --limit 20                    # Get order book (top 20)

# Orders
revx order place BTC-USD buy --qty 0.001 --market           # Market buy (base qty)
revx order place BTC-USD buy --quote 100 --market           # Market buy (quote amount)
revx order place BTC-USD sell --qty 0.001 --limit 95000     # Limit sell
revx order place BTC-USD buy --qty 0.001 --limit 95000 --post-only
revx order open                                             # List active orders
revx order open --symbols BTC-USD --side buy                # Filter active orders
revx order history --symbols BTC-USD                        # Order history for pair
revx order get <order-id>                                   # Get order details
revx order fills <order-id>                                 # Get order fills
revx order cancel <order-id>                                # Cancel an order
revx order cancel --all                                     # Cancel all open orders

# Trades
revx trade private BTC-USD                                  # Private trade history
revx trade private BTC-USD --limit 100 --start-date 7d
revx trade public BTC-USD                                   # All public trades
revx trade public BTC-USD --start-date 7d --limit 200

# Monitor (runs in foreground, Ctrl-C to stop)
revx monitor price BTC-USD --direction above --threshold 100000
revx monitor rsi ETH-USD --direction above --threshold 70 --period 14
revx monitor ema-cross BTC-USD --direction bullish
revx monitor macd BTC-USD --direction bullish --fast 12 --slow 26 --signal 9
revx monitor bollinger BTC-USD --band upper
revx monitor volume-spike BTC-USD --multiplier 3.0
revx monitor spread BTC-USD --direction above --threshold 0.5
revx monitor obi BTC-USD --direction above --threshold 0.3
revx monitor price-change BTC-USD --direction rise --threshold 5.0 --lookback 24
revx monitor atr-breakout BTC-USD --period 14 --multiplier 1.5
revx monitor types                                          # List all monitor types

# Strategy
revx strategy grid backtest BTC-USD --levels 10 --range 10 --investment 1000
revx strategy grid optimize BTC-USD --investment 1000 --days 30 --interval 1h
revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5
revx strategy grid run BTC-USD --investment 500 --dry-run

# Connector (Telegram notifications)
revx connector telegram add --token <token> --chat-id <id>
revx connector telegram add --token <token> --chat-id <id> --test
revx connector telegram list
revx connector telegram test <id>
revx connector telegram delete <id>

# Events
revx events                                                 # Show recent alert events
revx events --limit 10                                      # Show last 10 events
revx events --category alert_triggered                      # Filter by category
```

---

## MCP Usage Examples

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

---

## Configuration

Credentials are stored locally on your machine — the private key never leaves your filesystem.

| Platform | Config directory |
|----------|-----------------|
| macOS / Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |

Override with `REVOLUTX_CONFIG_DIR`.

Files:
- `config.json` — API key
- `private.pem` — Ed25519 private key
- `public.pem` — Ed25519 public key (register with Revolut X)

---

## Install CLI Skill as a plugin

### Claude Code

Add this repo as a marketplace, then install the plugin:

```bash
claude plugin marketplace add https://github.com/revolut-engineering/revolut-x-api.git
claude plugin install revolut-x@revolut-x-plugins
```

Or load directly from a local clone:

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
claude --plugin-dir ./revolut-x-api
```

This installs skills that teach Claude how to use the `revx` CLI.

### Gemini CLI

```bash
gemini extensions install https://github.com/revolut-engineering/revolut-x-api
```

---

## Privacy Policy

All data stays on your machine. API credentials are sent only to `revx.revolut.com` — no data is sent to Anthropic, the developer, or any third party.

For the full privacy policy, see [PRIVACY.md](PRIVACY.md).

---

## Support

- **Issues:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)
- **Revolut X API Docs:** [developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api)

## License

MIT — see [LICENSE](LICENSE)
