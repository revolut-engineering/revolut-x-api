---
name: revx-cli
description: >
  Revolut X crypto exchange CLI reference. This skill should be used when the user asks to
  "run revx commands", "check my Revolut X balances", "place an order on Revolut X",
  "monitor crypto prices", "set up the revx CLI", "backtest a grid strategy",
  "run a grid bot", "cancel orders", "view candles", "get ticker prices",
  "manage Telegram alerts", or mentions revx, revolutx-cli, or Revolut X CLI.
  Covers all revx subcommands: configure, account, market, order, trade, monitor,
  strategy (grid backtest/optimize/run), connector (Telegram), and events.
---

# Revolut X CLI Skill (`revx`)

> Complete reference for generating, explaining, and troubleshooting `revx` CLI commands.

## Quick Reference

| Command Group | Purpose |
|---|---|
| `revx configure` | Setup API key, keypair, passkey |
| `revx account` | Balances |
| `revx market` | Currencies, pairs, tickers, candles, order book |
| `revx order` | Place, open, history, get, cancel, fills |
| `revx trade` | Private and public trade history |
| `revx monitor` | Live price/indicator alerts (10 types) |
| `revx strategy grid` | Backtest, optimize, run grid bot |
| `revx connector telegram` | Telegram notification management |
| `revx events` | View alert/notification events |

All data commands support `--json` or `--output json` for machine-readable output.

---

## Installation

### Prerequisites

- **Node.js >= 20** (check with `node -v`)
- **npm** (comes with Node.js)

### Install

```bash
npm install -g cli-k9x2a && npm link cli-k9x2a
```

After install, `revx` is available as a global command:

```bash
revx --version                # Should print the version
```

---

## Behavioral Instructions for Claude

### Long-Running Commands

The following commands run **indefinitely** (polling loops with live dashboard output):

- `revx monitor <type> ...` (all monitor subcommands)
- `revx strategy grid run ...` (including `--dry-run` — dry-run still runs a continuous loop)

**NOT long-running** (run normally via `Bash` tool):
- `revx strategy grid backtest ...` — completes and returns results
- `revx strategy grid optimize ...` — completes and returns results

**How to handle:**

1. Run the command using the `Bash` tool with `run_in_background: true` — this frees Claude immediately while the process runs asynchronously
2. Periodically read the background task output file with the `Read` tool to monitor status and report key events to the user (alerts triggered, orders placed, errors)
3. If the user asks to stop, use the `TaskStop` tool with the task ID
4. Also print the command to the user so they can optionally run it in a separate terminal for the full live dashboard experience (with colors, real-time tables, Ctrl+C to stop)

**Example — starting a monitor:**

Bash tool call:
```json
{ "command": "revx monitor price BTC-USD --direction above --threshold 100000", "run_in_background": true }
```

Response to user:

> Started monitoring BTC-USD price in the background. I'll check for alerts periodically.
>
> If you'd like to see the live dashboard, run this in a separate terminal:
> ```bash
> revx monitor price BTC-USD --direction above --threshold 100000
> ```
> Press Ctrl+C to stop. Alerts will also be sent to Telegram if configured.

### Permission Handling for Recurring Commands (/loop)

When using `/loop` to run `revx` commands on an interval, each iteration triggers a permission prompt. To avoid repeated approvals, Claude must request permission for the **specific commands** once before starting the loop.

**Before starting a `/loop` with `revx` commands:**

1. Determine the exact `revx` commands needed for each iteration (e.g., `revx account balances`, `revx order open`)
2. Run each command as a **separate `Bash` tool call** — do NOT chain with `&&` or pipes. This ensures each command matches a simple permission pattern
3. Present the specific commands to the user and ask for permission to add them to the allowlist
4. Use the `update-config` skill to add **specific** permission patterns to `.claude/settings.local.json`, e.g.:
   ```json
   "Bash(revx account balances*)",
   "Bash(revx order open*)"
   ```
   Do NOT add a blanket `Bash(revx *)` — only add the exact commands the loop needs
5. Then start the `/loop`

**Permission pattern syntax:** `Bash(revx account balances*)` uses a glob wildcard — the trailing `*` allows optional flags. The pattern uses a **space** separator (not colon). Compound commands with `&&` or `|` are split into subcommands, each checked independently.

**Example flow** for "every 10 min check my balance and open orders":

1. Determine needs: `revx account balances` and `revx order open`
2. Tell the user: "I'll run these two commands each iteration — can I add them to your permission allowlist?"
3. On approval, add `Bash(revx account balances*)` and `Bash(revx order open*)` via `update-config`
4. Start `/loop 10m check balance and open orders`
5. Each iteration runs two separate `Bash` calls — no further prompts

---


## User Journey: From Install to First Trade

### Step 1: Configure Authentication

```bash
revx configure                 # Interactive setup wizard
```

This will:
1. Generate an Ed25519 keypair (private + public key)
2. Display your public key — copy it
3. Prompt you to register the public key at **exchange.revolut.com -> Profile -> API Keys**
4. Prompt for the 64-character API key you receive after registration

Or do it step-by-step:

```bash
revx configure generate-keypair          # Creates Ed25519 keypair
# Register public key at exchange.revolut.com -> Profile -> API Keys
revx configure set --api-key <64-char-key>
```

### Step 2: Verify Configuration

```bash
revx configure get             # Show config status (keys redacted)
revx configure path            # Print config directory path
```

### Step 3: (Optional) Set a Passkey

A passkey is required for placing and cancelling orders. Set it once:

```bash
revx configure passkey set     # Prompts for passkey
revx configure passkey status  # Verify passkey is set
```

### Step 4: Check Your Account

```bash
revx account balances          # View non-zero balances
```

### Step 5: Explore the Market

```bash
revx market tickers            # See all prices
revx market ticker BTC-USD     # Check a specific pair
revx market candles BTC-USD    # View recent price history
```

### Step 6: Place Your First Order

```bash
# Start small — buy $10 of BTC at market price
revx order place BTC-USD buy --quote 10 --market

# Check it
revx order history --symbols BTC-USD
```

### Step 7: Set Up Monitoring (Optional)

```bash
# Get Telegram alerts
revx connector telegram add --token <bot-token> --chat-id <chat-id> --test

# Monitor BTC price
revx monitor price BTC-USD --direction above --threshold 100000
```

### Step 8: Try a Grid Bot (Optional)

```bash
# Backtest first
revx strategy grid backtest BTC-USD --investment 500 --levels 10 --range 5

# Dry run (no real orders)
revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5 --dry-run
```

---

## Configuration

### Config Commands

```bash
revx configure                          # Interactive setup wizard
revx configure get                      # Show config status (keys redacted)
revx configure set --api-key <key>      # Set API key
revx configure generate-keypair         # Generate Ed25519 keypair
revx configure path                     # Print config directory path
revx configure passkey set              # Set or change passkey
revx configure passkey remove           # Remove passkey
revx configure passkey status           # Show passkey status
```

### Config Location

| Platform | Path |
|---|---|
| macOS/Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |
| Override | `REVOLUTX_CONFIG_DIR` env var |

---

## Account

```bash
revx account balances                          # Non-zero balances
revx account balances --all                    # Include zero balances
revx account balances BTC                      # Single currency (case-insensitive)
revx account balances --currencies BTC,ETH,USD # Filter by multiple currencies
```

---

## Market Data

```bash
revx market currencies                 # All currencies (symbol, name, type, scale, status)
revx market currencies fiat            # Fiat currencies only
revx market currencies crypto          # Crypto currencies only
revx market currencies --filter BTC,ETH  # Filter by specific symbols
revx market pairs                      # All pairs (base, quote, min/max size, status)
revx market pairs --filter BTC-USD,ETH-USD  # Filter by specific pairs
revx market tickers                    # All tickers (bid, ask, mid, last)
revx market tickers --symbols BTC-USD,ETH-USD
revx market ticker BTC-USD             # Single ticker (key-value display)
```

### Candles

```bash
revx market candles BTC-USD                              # Default: 1h, last 100
revx market candles BTC-USD --interval 5m                # 5-minute candles
revx market candles BTC-USD --since 7d --until today     # Last 7 days
revx market candles ETH-USD --interval 4h --since 30d
```

**Intervals:** `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `2d`, `4d`, `1w`, `2w`, `4w` (or raw minutes)

**Time formats:** Relative (`7d`, `1w`, `4h`, `30m`, `today`, `yesterday`), ISO date, Unix epoch ms

### Order Book

```bash
revx market orderbook BTC-USD          # Top 10 levels (default)
revx market orderbook BTC-USD --limit 20
```

Depth: 1-20 levels.

---

## Orders

### Place Orders

```bash
# Market order (buy 0.001 BTC at best price)
revx order place BTC-USD buy --qty 0.001 --market

# Limit order (buy 0.001 BTC at $95,000 or better)
revx order place BTC-USD buy --qty 0.001 --limit 95000

# Post-only limit (maker only, cancelled if would take)
revx order place BTC-USD buy --qty 0.001 --limit 95000 --post-only

# Quote-sized order (buy $500 worth of BTC at market)
revx order place BTC-USD buy --quote 500 --market
```

**Arguments:** `<symbol> <side>`
- `symbol`: `BASE-QUOTE` format (e.g., `BTC-USD`, `ETH-EUR`)
- `side`: `buy` or `sell` (case-insensitive)

**Flags:**
| Flag | Description |
|---|---|
| `--qty <amount>` | Size in base currency (e.g., 0.001 for BTC) |
| `--quote <amount>` | Size in quote currency (e.g., 500 for USD) |
| `--market` | Market order (required unless `--limit`) |
| `--limit <price>` | Limit price (required unless `--market`) |
| `--post-only` | Post-only execution (limit orders only) |

Must specify either `--qty` or `--quote` (not both).

**Passkey required** for all order placement and cancellation.

### Manage Orders

```bash
# List open/active orders
revx order open
revx order open --symbols BTC-USD,ETH-USD --side buy
revx order open --order-states pending_new,new --order-types limit --limit 50

# Order history
revx order history
revx order history --symbols BTC-USD --start-date 7d --end-date today
revx order history --order-states filled,cancelled --limit 20

# Single order details
revx order get <order-id>

# Fills for an order
revx order fills <order-id>

# Cancel a single order
revx order cancel <order-id>

# Cancel all open orders
revx order cancel --all
```

**Open order filters:** `--symbols`, `--order-states` (pending_new, new, partially_filled), `--order-types` (limit, conditional, tpsl), `--side`, `--limit`

**History filters:** `--symbols`, `--order-states` (filled, cancelled, rejected, replaced), `--order-types` (market, limit), `--start-date`, `--end-date`, `--limit`

---

## Trades

```bash
revx trade private BTC-USD                                # My trade history
revx trade private BTC-USD --start-date 7d --limit 100
revx trade public BTC-USD                                 # Public trades
revx trade public BTC-USD --start-date 7d --end-date today
```

Aliases: `revx trade history` works as alias for `private`, `revx trade all` works as alias for `public`.

---

## Monitor (Live Alerts)

Monitors run in the **foreground** and poll on an interval. Press Ctrl+C to stop. If Telegram connectors are configured, alerts are sent as notifications.


### All Monitor Types

```bash
# Price threshold
revx monitor price BTC-USD --direction above --threshold 100000

# RSI (Relative Strength Index)
revx monitor rsi ETH-USD --direction above --threshold 70 --period 14

# EMA crossover
revx monitor ema-cross BTC-USD --direction bullish --fast-period 9 --slow-period 21

# MACD crossover
revx monitor macd BTC-USD --direction bullish --fast 12 --slow 26 --signal 9

# Bollinger Bands breach
revx monitor bollinger BTC-USD --band upper --period 20 --std-mult 2

# Volume spike
revx monitor volume-spike BTC-USD --period 20 --multiplier 2.0

# Bid-ask spread
revx monitor spread BTC-USD --direction above --threshold 0.5

# Order book imbalance
revx monitor obi BTC-USD --direction above --threshold 0.3

# Price change percentage
revx monitor price-change BTC-USD --direction rise --threshold 5.0 --lookback 24

# ATR breakout
revx monitor atr-breakout BTC-USD --period 14 --multiplier 1.5

# List all types with descriptions
revx monitor types
```

**Common option:** `--interval <seconds>` (minimum 5, default 10)

### Monitor Defaults

| Type | Key Defaults |
|---|---|
| `price` | direction: above, threshold: **required** |
| `rsi` | direction: above, threshold: 70, period: 14 |
| `ema-cross` | direction: bullish, fast: 9, slow: 21 |
| `macd` | direction: bullish, fast: 12, slow: 26, signal: 9 |
| `bollinger` | band: upper, period: 20, std-mult: 2 |
| `volume-spike` | period: 20, multiplier: 2.0 |
| `spread` | direction: above, threshold: 0.5 |
| `obi` | direction: above, threshold: 0.3 |
| `price-change` | direction: rise, threshold: 5.0, lookback: 24 |
| `atr-breakout` | period: 14, multiplier: 1.5 |

---

## Strategy (Grid Bot)

### Backtest

Test a grid strategy on historical data:

```bash
revx strategy grid backtest BTC-USD
revx strategy grid backtest BTC-USD --levels 10 --range 10 --investment 1000
revx strategy grid backtest ETH-USD --days 60 --interval 4h
revx strategy grid backtest BTC-USD --json
```

| Flag | Default | Description |
|---|---|---|
| `--levels <n>` | 5 | Grid levels per side (2-25) |
| `--range <pct>` | 10 | Grid range +/- % from mid price |
| `--investment <amount>` | 1000 | Capital in quote currency |
| `--days <n>` | 30 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |

### Optimize

Test multiple parameter combinations, ranked by return:

```bash
revx strategy grid optimize BTC-USD
revx strategy grid optimize BTC-USD --investment 5000 --days 60
revx strategy grid optimize BTC-USD --levels 5,10,15,20 --ranges 3,5,10 --top 5
```

| Flag | Default | Description |
|---|---|---|
| `--levels <csv>` | 3,5,8,10,15 | Level counts to test |
| `--ranges <csv>` | 3,5,7,10,12,15,20 | Range percentages to test |
| `--top <n>` | 10 | Top results to display |
| `--investment <amount>` | 1000 | Capital in quote currency |
| `--days <n>` | 30 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |

Max 200 parameter combinations.

### Run (Live Trading)

Run a live grid bot with real-time dashboard:

```bash
revx strategy grid run BTC-USD --investment 500
revx strategy grid run BTC-USD --levels 10 --range 5 --investment 1000 --interval 30
revx strategy grid run BTC-USD --investment 500 --split
revx strategy grid run BTC-USD --investment 100 --dry-run
revx strategy grid run BTC-USD --investment 500 --reset
```

| Flag | Default | Description |
|---|---|---|
| `--investment <amount>` | **required** | Capital in quote currency |
| `--levels <n>` | 5 | Grid levels per side (2-25) |
| `--range <pct>` | 5 | Grid range +/- % from mid |
| `--split` | off | Market-buy 50% base at start |
| `--interval <sec>` | 10 | Polling interval in seconds |
| `--dry-run` | off | Simulate without real orders |
| `--reset` | off | Discard saved state, start fresh |

**Passkey required.** Ctrl+C for graceful shutdown (cancels open orders, prints summary).

**Persistence:** State auto-saved for crash recovery. Clean shutdown deletes state. Crashed sessions auto-reconcile on restart.

---

## Connector (Telegram)

```bash
# Add connection
revx connector telegram add --token <bot-token> --chat-id <chat-id>
revx connector telegram add --token <token> --chat-id <id> --label prod --test

# Manage
revx connector telegram list
revx connector telegram test <connection-id>
revx connector telegram enable <connection-id>
revx connector telegram disable <connection-id>
revx connector telegram delete <connection-id>
```

| Flag | Description |
|---|---|
| `--token <token>` | Telegram Bot API token (required for add) |
| `--chat-id <id>` | Telegram chat ID (required for add) |
| `--label <name>` | Connection label (default: "default") |
| `--test` | Send test message after adding |
| `--message <msg>` | Custom test message (for `test` subcommand) |

---

## Events

```bash
revx events                            # Last 50 events
revx events --limit 10
revx events --category alert_triggered
revx events --json
```

---

## Symbol Format

All symbols use `BASE-QUOTE` with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`.

Use `revx market pairs` to see all valid pairs with their min/max sizes and step sizes.

---

## Error Reference

| Error | Cause | Fix |
|---|---|---|
| Auth not configured | Missing API key or private key | Run `revx configure` |
| Authentication failed (401) | Invalid key or signature | Re-register public key at exchange.revolut.com |
| Rate limit (429) | Too many requests | Wait for `retryAfter` duration |
| Order rejected (400) | Invalid params or insufficient funds | Check pair constraints via `revx market pairs` |
| Not found (404) | Invalid order ID | Verify with `revx order open` |
| Network error | Connection/timeout failure | Check connectivity, retry |

---

## Common Workflows

### "What's my BTC worth?"
```bash
revx account balances BTC
revx market ticker BTC-USD
```

### "Set up price alert with Telegram"
```bash
revx connector telegram add --token <token> --chat-id <id> --test
revx monitor price BTC-USD --direction above --threshold 100000
```

### "Backtest then run a grid bot"
```bash
revx strategy grid optimize BTC-USD --investment 1000 --days 30
# Pick best parameters from results
revx strategy grid backtest BTC-USD --levels 10 --range 7 --investment 1000
# Dry run first
revx strategy grid run BTC-USD --investment 1000 --levels 10 --range 7 --dry-run
# Go live
revx strategy grid run BTC-USD --investment 1000 --levels 10 --range 7
```

### "Review recent trading activity"
```bash
revx order history --start-date 7d
revx trade private BTC-USD --start-date 7d
revx events --limit 20
```
