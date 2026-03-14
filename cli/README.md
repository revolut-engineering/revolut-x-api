# revolutx-cli

Command-line interface for [Revolut X Exchange](https://revx.revolut.com). Trade crypto from your terminal.

## Installation

Download `revolutx-cli-*.tgz` from the [latest release](https://github.com/revolut-engineering/revolut-x-api/releases/latest), then:

```bash
npm install -g ./revolutx-cli-*.tgz
```

The CLI tarball includes the API client bundled inside — no extra dependencies to install.

Or from source:

```bash
# Build the API dependency first
cd api && npm install && npm run build && cd ..
# Then build and link the CLI
cd cli && npm install && npm run build && npm link
```

> **Troubleshooting:** If `revx` is not found after `npm link`, your shell may not
> have the npm global `bin` directory on `PATH`. Fix with one of:
>
> ```bash
> # Check where npm linked the binary
> npm bin -g
>
> # Option 1: asdf users — regenerate shims
> asdf reshim nodejs
>
> # Option 2: Add npm global bin to PATH (add to ~/.zshrc or ~/.bashrc)
> export PATH="$(npm bin -g):$PATH"
>
> # Option 3: Run directly without PATH
> npx revx --version
> ```

Requires Node.js 20+.

## Quick Start

```bash
revx configure                              # Setup API key + keypair
revx account balances                       # Check balances
revx market ticker BTC-USD                  # Get price
revx order place BTC-USD buy 0.001 --limit 95000  # Place limit buy
revx monitor price BTC-USD --threshold 100000     # Monitor price level
revx strategy grid backtest BTC-USD               # Backtest grid strategy
revx strategy grid run BTC-USD --investment 500   # Run live grid bot
```

## Commands

### Configure

```bash
revx configure                     # Interactive setup (API key + keypair)
revx configure get                 # Show current config (redacted)
revx configure set --api-key KEY   # Set API key
revx configure generate-keypair    # Generate Ed25519 keypair
revx configure path                # Print config directory path
```

### Account

```bash
revx account balances              # List non-zero balances
revx account balances --all        # Include zero balances
revx account balance BTC           # Single currency balance
```

### Market Data

```bash
revx market currencies             # List all currencies
revx market pairs                  # List all trading pairs
revx market tickers                # All tickers
revx market ticker BTC-USD         # Single pair ticker
revx market candles BTC-USD        # OHLCV candles (default 1h)
  --interval 60                    # Minutes: 5,15,30,60,240,1440,...
  --since 2025-01-01               # Start (ISO date or epoch ms)
  --until 2025-01-02               # End
revx market orderbook BTC-USD      # Order book snapshot
  --limit 10                       # Depth (1-20)
```

### Orders

```bash
revx order place BTC-USD buy 0.001 --limit 95000    # Limit buy
revx order place BTC-USD sell 0.001 --market         # Market sell
  --quote-size 100                                    # By quote amount
  --post-only                                         # Post-only
revx order list                     # Active orders
  --symbol BTC-USD                  # Filter by pair
  --side buy                        # Filter by side
  --limit 50                        # Max results
revx order history                  # Historical orders
  --symbol BTC-USD
  --start-date 2025-01-01
  --end-date 2025-01-02
  --limit 50                        # Max results
revx order get <order-id>           # Get specific order
revx order cancel <order-id>        # Cancel order
revx order fills <order-id>         # Get fills for order
```

### Trades

```bash
revx trade history BTC-USD          # My trade history
  --start-date 2025-01-01
  --end-date 2025-01-02
  --limit 50
```

### Monitor

Live monitoring for price thresholds and technical indicators. Each monitor type has its own subcommand with dedicated flags. Monitors run in the foreground, check on an interval, and send Telegram notifications when conditions trigger.

```bash
revx monitor types                  # List all supported monitor types
```

```bash
# Price threshold
revx monitor price BTC-USD --direction above --threshold 100000

# RSI
revx monitor rsi ETH-USD --direction above --threshold 70 --period 14

# EMA crossover
revx monitor ema-cross BTC-USD --direction bullish

# MACD crossover
revx monitor macd BTC-USD --direction bullish --fast 12 --slow 26 --signal 9

# Bollinger Bands
revx monitor bollinger BTC-USD --band upper

# Volume spike
revx monitor volume-spike BTC-USD --period 20 --multiplier 2.0

# Bid-ask spread
revx monitor spread BTC-USD --direction above --threshold 0.5

# Order book imbalance
revx monitor obi BTC-USD --direction above --threshold 0.3

# Price change %
revx monitor price-change BTC-USD --direction rise --threshold 5.0 --lookback 24

# ATR breakout
revx monitor atr-breakout BTC-USD --period 14 --multiplier 1.5
```

All monitor subcommands accept `--interval <sec>` to set the check interval in seconds (minimum 5, default: `10`).

| Subcommand | Flags | Defaults |
|---|---|---|
| `price <pair>` | `--direction <above\|below>`, `--threshold <value>` (required) | direction: `above` |
| `rsi <pair>` | `--direction <above\|below>`, `--threshold <value>`, `--period <n>` | threshold: `70`, period: `14` |
| `ema-cross <pair>` | `--direction <bullish\|bearish>`, `--fast-period <n>`, `--slow-period <n>` | direction: `bullish`, fast: `9`, slow: `21` |
| `macd <pair>` | `--direction <bullish\|bearish>`, `--fast <n>`, `--slow <n>`, `--signal <n>` | direction: `bullish`, fast: `12`, slow: `26`, signal: `9` |
| `bollinger <pair>` | `--band <upper\|lower>`, `--period <n>`, `--std-mult <n>` | band: `upper`, period: `20`, std-mult: `2` |
| `volume-spike <pair>` | `--period <n>`, `--multiplier <n>` | period: `20`, multiplier: `2.0` |
| `spread <pair>` | `--direction <above\|below>`, `--threshold <value>` | direction: `above`, threshold: `0.5` |
| `obi <pair>` | `--direction <above\|below>`, `--threshold <value>` | direction: `above`, threshold: `0.3` |
| `price-change <pair>` | `--direction <rise\|fall>`, `--threshold <value>`, `--lookback <n>` | direction: `rise`, threshold: `5.0`, lookback: `24` |
| `atr-breakout <pair>` | `--period <n>`, `--multiplier <n>` | period: `14`, multiplier: `1.5` |

### Strategy

Automated trading strategies that run as foreground processes with a live dashboard.

#### Grid Bot

A grid trading strategy that places buy orders below the current price and sell orders above it, capturing profit from price oscillation within a range.

##### Backtest

Run a backtest on historical candle data:

```bash
revx strategy grid backtest BTC-USD
revx strategy grid backtest BTC-USD --levels 10 --range 10 --investment 1000
revx strategy grid backtest ETH-USD --days 60 --interval 4h --fee-rate 0.1
revx strategy grid backtest BTC-USD --json
```

| Flag | Description | Default |
|---|---|---|
| `--levels <n>` | Number of grid levels | `10` |
| `--range <pct>` | Grid range as percentage (e.g. `10` for ±10%) | `10` |
| `--investment <usd>` | Capital in USD | `1000` |
| `--days <n>` | Days of historical data | `30` |
| `--interval <res>` | Candle resolution (`5m`, `15m`, `30m`, `1h`, `4h`, `1d`) | `1h` |
| `--fee-rate <rate>` | Fee rate as percentage (e.g. `0.1` for 0.1%) | `0` |
| `--json` | Output as JSON | — |

##### Optimize

Test multiple parameter combinations and rank by return:

```bash
revx strategy grid optimize BTC-USD
revx strategy grid optimize BTC-USD --investment 5000 --days 60
revx strategy grid optimize BTC-USD --levels 5,10,15,20 --ranges 3,5,10 --top 5
```

| Flag | Description | Default |
|---|---|---|
| `--investment <usd>` | Capital in USD | `1000` |
| `--days <n>` | Days of historical data | `30` |
| `--interval <res>` | Candle resolution | `1h` |
| `--fee-rate <rate>` | Fee rate as percentage | `0` |
| `--levels <csv>` | Comma-separated level counts to test | `5,8,10,12,15,20,25,30` |
| `--ranges <csv>` | Comma-separated range percentages to test | `3,5,7,10,12,15,20` |
| `--top <n>` | Number of top results to show | `10` |
| `--json` | Output as JSON | — |

##### Run (Live Trading)

Run a live grid bot as a foreground process with a real-time dashboard:

```bash
revx strategy grid run BTC-USD --investment 500
revx strategy grid run BTC-USD --levels 10 --range 5 --investment 1000 --interval 30
revx strategy grid run BTC-USD --investment 500 --split
revx strategy grid run BTC-USD --investment 100 --dry-run
```

| Flag | Description | Default |
|---|---|---|
| `--investment <usd>` | Capital in USD to deploy (required) | — |
| `--levels <n>` | Number of grid levels | `10` |
| `--range <pct>` | Grid range as percentage (e.g. `5` for ±5%) | `5` |
| `--split` | Market-buy 50% of investment at start | — |
| `--interval <sec>` | Polling interval in seconds | `30` |
| `--dry-run` | Simulate without placing real orders | — |

**Persistence:** State is saved periodically during the session for crash safety. On clean shutdown (Ctrl+C), all open orders are cancelled and the state file is deleted — the next session starts fresh. If some orders could not be cancelled (network error, etc.), the state file is kept for automatic reconciliation on the next startup.

**Reconciliation:** If a state file exists from a previous crash or partial cancellation, the bot automatically reconciles on startup. Orders that filled while offline are accounted for (P&L tracked). Leftover active orders matching the new grid's price levels are adopted; non-matching ones are cancelled. A completely new grid is then initialized.

**Telegram notifications:** If Telegram connections are configured (via `revx connector telegram add`), the grid bot automatically sends notifications on order fills, startup, and shutdown.

### Connector

Manage notification connectors (e.g. Telegram) for alert notifications.

#### Telegram

```bash
revx connector telegram list                  # List all connections
revx connector telegram delete <conn-id>     # Delete a connection
revx connector telegram enable <conn-id>    # Enable a connection
revx connector telegram disable <conn-id>   # Disable a connection
revx connector telegram test <conn-id>      # Send a test message
  --message "Custom text"                    # Optional custom message
```

Add a connection:

```bash
# Add with default label
revx connector telegram add --token "123456:ABC-DEF..." --chat-id "987654321"

# Add with custom label
revx connector telegram add --token "123456:ABC-DEF..." --chat-id "987654321" --label "main-alerts"

# Add and send test message
revx connector telegram add --token "123456:ABC-DEF..." --chat-id "987654321" --test
```

Options for `connector telegram add`:
- `--token <token>` — Telegram Bot API token (required)
- `--chat-id <id>` — Telegram chat ID (required)
- `--label <label>` — Connection label (default: `default`)
- `--test` — Send a test message after adding

### Events

View alert trigger and notification events.

```bash
revx events                                    # Show recent events (last 50)
revx events --limit 10                         # Show last 10 events
revx events --category alert_triggered         # Filter by category
revx events --json                             # Output as JSON
```

Options:
- `--limit <n>` — Number of events to show (default: `50`)
- `--category <type>` — Filter by category: `alert_triggered`, `telegram_send_ok`, `telegram_send_fail`
- `--json` — Output as JSON

## Output Formats

```bash
revx account balances                    # Default: table
revx account balances --json             # JSON output
revx account balances --output json      # Same as --json
revx account balances --output table     # Explicit table
```

Default output is formatted tables for terminals. Use `--json` for scripts and piping.

## Configuration

Credentials are stored in the platform config directory:

| Platform | Path |
|----------|------|
| macOS | `~/.config/revolut-x/` |
| Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |

Override with `REVOLUTX_CONFIG_DIR` environment variable.

Files:
- `config.json` — API key
- `private.pem` — Ed25519 private key
- `public.pem` — Ed25519 public key (register with Revolut X)

## Support

- **Issues:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)
- **Revolut X API Docs:** [developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api)

## License

MIT
