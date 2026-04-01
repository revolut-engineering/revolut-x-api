# revolut-x-api

Monorepo for open-source tooling around the [Revolut X](https://exchange.revolut.com/) crypto exchange.

## Packages

| Package | Description |
|---------|-------------|
| [`api/`](api/) | Typed HTTP client for the Revolut X REST API. Zero runtime dependencies — Node.js built-ins only. |
| [`mcp/`](mcp/) | MCP server exposing 23 tools for market data, account management, orders, monitoring, and grid strategy backtests. Use with Claude Desktop, Claude Code, or any MCP-compatible client. |
| [`cli/`](cli/) | `revx` command-line interface for trading, monitoring, and running grid bots from the terminal. |
| [`skills/revx-cli/`](skills/revx-cli/) | Claude Code skill — complete `revx` CLI command reference. |

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
revx configure                              # Set up API keys
revx account balances                       # Check balances
revx market ticker BTC-USD                  # Get price
revx order place BTC-USD buy --qty 0.001 --limit 95000
revx monitor price BTC-USD --threshold 100000
revx strategy grid backtest BTC-USD
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
