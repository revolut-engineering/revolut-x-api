# revolut-x cli

Command-line interface for [Revolut X Public Trading API](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api). Trade crypto from your terminal.

[![npm](https://img.shields.io/npm/v/revolutx-cli)](https://www.npmjs.com/package/cli-k9x2a)
[![Node.js](https://img.shields.io/node/v/revolutx-cli)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
  - [configure](#configure)
  - [account](#account)
  - [market](#market)
  - [order](#order)
  - [trade](#trade)
  - [monitor](#monitor)
  - [strategy](#strategy)
  - [connector](#connector)
  - [events](#events)
- [Output Formats](#output-formats)
- [Configuration](#configuration)
- [Support](#support)

---

## Installation

Download `revolutx-cli-*.tgz` from the [latest release](https://github.com/revolut-engineering/revolut-x-api/releases/latest), then:

```bash
npm install -g ./revolutx-cli-*.tgz
```

The CLI tarball includes the API client bundled inside — no extra dependencies to install.

### Build from source

```bash
cd api && npm install && npm run build && cd ..
cd cli && npm install && npm run build && npm link && cd ..
```

> **Troubleshooting:** If `revx` is not found after `npm link`, your shell may not have the npm global `bin` directory on `PATH`. Fix with one of:
>
> ```bash
> npm bin -g                    # Check where npm linked the binary
>
> asdf reshim nodejs            # asdf users: regenerate shims
>
> export PATH="$(npm bin -g):$PATH"   # Add to ~/.zshrc or ~/.bashrc
>
> npx revx --version            # Run directly without PATH changes
> ```

Requires Node.js 20+.

---

## Quick Start

```bash
revx configure                                          # Set up API key + keypair
revx account balances                                   # Check balances
revx market ticker BTC-USD                              # Get current price
revx order place BTC-USD buy --qty 0.001 --limit 95000  # Place a limit buy
revx monitor price BTC-USD --threshold 100000           # Alert when price crosses
revx strategy grid backtest BTC-USD                     # Backtest grid strategy
revx strategy grid run BTC-USD --investment 500         # Run live grid bot
```

---

## Commands

### configure

Manage API credentials and configuration.

```bash
revx configure                          # Interactive setup wizard (API key + keypair)
revx configure get                      # Show current config (redacted)
revx configure set --api-key <key>      # Update API key
revx configure generate-keypair         # Generate Ed25519 keypair
revx configure path                     # Print config directory path
```

---

### account

```bash
revx account balances                   # List non-zero balances
revx account balances --all             # Include zero balances
revx account balances BTC               # Single currency balance
revx account balances --currencies BTC,ETH,USD  # Filter by currencies
revx account balances --json            # Output as JSON
```

---

### market

```bash
revx market currencies                  # List all currencies
revx market currencies fiat             # Fiat currencies only
revx market currencies crypto           # Crypto currencies only
revx market pairs                       # List all trading pairs
revx market pairs BTC-USD               # Get BTC-USD pair info
revx market pairs --pairs BTC-USD,ETH-USD  # Filter by pairs
revx market tickers                     # All tickers
revx market tickers --symbols BTC-USD,ETH-USD  # Filter by pairs
revx market ticker BTC-USD              # Single pair ticker
revx market candles BTC-USD             # OHLCV candles (default 1h)
  --interval 1h                         # Resolution: 1m 5m 15m 30m 1h 4h 1d 2d 4d 1w 2w 4w
  --since 7d                            # Start (relative: 7d 1w 4h 30m today yesterday; ISO; epoch ms)
  --until today                         # End (same formats)
revx market orderbook BTC-USD           # Order book snapshot (top 10)
  --limit 20                            # Depth (1–20)
```

---

### order

```bash
# Place orders
revx order place BTC-USD buy --qty 0.001 --limit 95000    # Limit buy (base qty)
revx order place BTC-USD buy --quote 100 --market         # Market buy (quote amount)
revx order place BTC-USD sell --qty 0.001 --market        # Market sell (base qty)
revx order place BTC-USD buy --qty 0.001 --limit 95000 --post-only

# View orders
revx order open                         # Active orders (alias: active)
  --symbols BTC-USD,ETH-USD             # Filter by pairs
  --order-states pending_new,new        # States: pending_new new partially_filled
  --order-types limit,conditional       # Types: limit conditional tpsl
  --side buy                            # Filter by side
  --limit 50                            # Max results
revx order history                      # Historical orders
  --symbols BTC-USD,ETH-USD             # Filter by pairs
  --order-states filled,cancelled       # States: filled cancelled rejected replaced
  --order-types market,limit            # Types: market limit
  --start-date 7d                       # Start (relative: 7d 1w today; ISO; epoch ms)
  --end-date today                      # End
  --limit 50                            # Max results
revx order get <order-id>               # Get specific order details
revx order fills <order-id>             # Get fills for an order

# Cancel orders
revx order cancel <order-id>            # Cancel a specific order
revx order cancel --all                 # Cancel all open orders
```

---

### trade

```bash
revx trade private BTC-USD              # My private trade history (alias: history)
  --start-date 7d                       # Start (relative: 7d 1w today; ISO; epoch ms)
  --end-date today                      # End
  --limit 50                            # Max results
revx trade public BTC-USD               # All public trades for a pair (alias: all)
  --start-date 7d
  --end-date today
  --limit 50
```

---

### monitor

Live monitoring for price thresholds and technical indicators. Runs in the foreground — press `Ctrl+C` to stop.

```bash
revx monitor types                      # List all supported monitor types
```

```bash
revx monitor price BTC-USD --direction above --threshold 100000
revx monitor rsi ETH-USD --direction above --threshold 70 --period 14
revx monitor ema-cross BTC-USD --direction bullish
revx monitor macd BTC-USD --direction bullish --fast 12 --slow 26 --signal 9
revx monitor bollinger BTC-USD --band upper
revx monitor volume-spike BTC-USD --period 20 --multiplier 2.0
revx monitor spread BTC-USD --direction above --threshold 0.5
revx monitor obi BTC-USD --direction above --threshold 0.3
revx monitor price-change BTC-USD --direction rise --threshold 5.0 --lookback 24
revx monitor atr-breakout BTC-USD --period 14 --multiplier 1.5
```

All monitor subcommands accept `--interval <sec>` (minimum `5`, default `10`).

| Subcommand | Flags | Defaults |
|---|---|---|
| `price <pair>` | `--direction <above\|below>`, `--threshold <value>` | direction: `above` |
| `rsi <pair>` | `--direction <above\|below>`, `--threshold <value>`, `--period <n>` | threshold: `70`, period: `14` |
| `ema-cross <pair>` | `--direction <bullish\|bearish>`, `--fast-period <n>`, `--slow-period <n>` | direction: `bullish`, fast: `9`, slow: `21` |
| `macd <pair>` | `--direction <bullish\|bearish>`, `--fast <n>`, `--slow <n>`, `--signal <n>` | direction: `bullish`, fast: `12`, slow: `26`, signal: `9` |
| `bollinger <pair>` | `--band <upper\|lower>`, `--period <n>`, `--std-mult <n>` | band: `upper`, period: `20`, std-mult: `2` |
| `volume-spike <pair>` | `--period <n>`, `--multiplier <n>` | period: `20`, multiplier: `2.0` |
| `spread <pair>` | `--direction <above\|below>`, `--threshold <value>` | direction: `above`, threshold: `0.5` |
| `obi <pair>` | `--direction <above\|below>`, `--threshold <value>` | direction: `above`, threshold: `0.3` |
| `price-change <pair>` | `--direction <rise\|fall>`, `--threshold <value>`, `--lookback <n>` | direction: `rise`, threshold: `5.0`, lookback: `24` |
| `atr-breakout <pair>` | `--period <n>`, `--multiplier <n>` | period: `14`, multiplier: `1.5` |

---

### strategy

Automated trading strategies that run as foreground processes with a live dashboard.

#### Grid Bot

Places buy orders below the current price and sell orders above it, capturing profit from oscillation within a range.

##### Backtest

Run a backtest on historical candle data:

```bash
revx strategy grid backtest BTC-USD
revx strategy grid backtest BTC-USD --levels 10 --range 10 --investment 1000
revx strategy grid backtest ETH-USD --days 60 --interval 4h
revx strategy grid backtest BTC-USD --json
```

| Flag | Description | Default |
|---|---|---|
| `--levels <n>` | Number of grid levels | `10` |
| `--range <pct>` | Grid range as % (e.g. `10` for ±10%) | `10` |
| `--investment <amount>` | Capital in quote currency | `1000` |
| `--days <n>` | Days of historical data | `30` |
| `--interval <res>` | Candle resolution (`1m` `5m` `15m` `30m` `1h` `4h` `1d`) | `1h` |
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
| `--investment <amount>` | Capital in quote currency | `1000` |
| `--days <n>` | Days of historical data | `30` |
| `--interval <res>` | Candle resolution | `1h` |
| `--levels <csv>` | Level counts to test (comma-separated) | `5,8,10,12,15,20,25,30` |
| `--ranges <csv>` | Range percentages to test (comma-separated) | `3,5,7,10,12,15,20` |
| `--top <n>` | Number of top results to show | `10` |
| `--json` | Output as JSON | — |

##### Run (Live)

Run a live grid bot with a real-time dashboard:

```bash
revx strategy grid run BTC-USD --investment 500
revx strategy grid run BTC-USD --levels 10 --range 5 --investment 1000 --interval 30
revx strategy grid run BTC-USD --investment 500 --split
revx strategy grid run BTC-USD --investment 100 --dry-run
```

| Flag | Description | Default |
|---|---|---|
| `--investment <amount>` | Capital in quote currency (required) | — |
| `--levels <n>` | Number of grid levels | `10` |
| `--range <pct>` | Grid range as % (e.g. `5` for ±5%) | `5` |
| `--split` | Market-buy 50% of investment at start | — |
| `--interval <sec>` | Polling interval in seconds | `30` |
| `--dry-run` | Simulate without placing real orders | — |

**Persistence:** State is saved periodically during the session. On clean shutdown (`Ctrl+C`), all open orders are cancelled and state is cleared — the next session starts fresh. If orders couldn't be cancelled (e.g. network error), the state file is kept for automatic reconciliation on next startup.

**Reconciliation:** On startup, if a previous crash state exists, the bot reconciles automatically: fills are accounted for, orders matching the new grid are adopted, non-matching ones are cancelled, then a fresh grid is initialized.

---

### connector

Manage notification connectors. Currently supports Telegram.

```bash
revx connector telegram add --token <token> --chat-id <id>         # Add connection
revx connector telegram add --token <token> --chat-id <id> --test  # Add and test
revx connector telegram list                                        # List connections
revx connector telegram test <id>                                   # Send test message
revx connector telegram enable <id>                                 # Enable connection
revx connector telegram disable <id>                                # Disable connection
revx connector telegram delete <id>                                 # Delete connection
```

Connectors receive alert notifications from `revx monitor` triggers.

---

### events

View alert trigger and notification events.

```bash
revx events                             # Recent events (last 50)
revx events --limit 10                  # Last 10 events
revx events --category alert_triggered  # Filter by category
revx events --json                      # Output as JSON
```

| Option | Description | Default |
|---|---|---|
| `--limit <n>` | Number of events to show | `50` |
| `--category <type>` | Filter: `alert_triggered` | — |
| `--json` | Output as JSON | — |

---

## Output Formats

All commands default to formatted tables. Use `--json` for scripting or piping.

```bash
revx account balances               # Formatted table
revx account balances --json        # JSON output
revx account balances --output json # Same as --json
```

---

## Configuration

Credentials are stored in the platform config directory:

| Platform | Path |
|----------|------|
| macOS / Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |

Override with the `REVOLUTX_CONFIG_DIR` environment variable.

| File | Contents |
|------|----------|
| `config.json` | API key |
| `private.pem` | Ed25519 private key |
| `public.pem` | Ed25519 public key (register with Revolut X) |
| `telegram.json` | Telegram notification bot tokens |

Credential files are written with owner-only permissions (`0o600`). The CLI refuses to load `private.pem` or `config.json` if their permissions are looser than that — if you hit an "insecure permissions" error, run `chmod 600 ~/.config/revolut-x/<file>`.

---

## Support

- **Issues:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)
- **Revolut X API Docs:** [developer.revolut.com/docs/x-api](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api)

## License

MIT
