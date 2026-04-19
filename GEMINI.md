# Revolut X CLI Skill (`revx`)

> Complete reference for generating, explaining, and troubleshooting `revx` CLI commands.

> **Auth auto-resolve.** If any `revx` command fails with an auth-related error — `Auth not configured`, `No private key found`, `Authentication failed (401)`, `Invalid signature`, `insecure permissions`, or a missing key/config file at `~/.config/revolut-x/` — apply the fix yourself before re-asking the user. Walk through the [Configuration](#configuration) and [Error Reference](#error-reference) sections of this document and run the appropriate fix command (`chmod 600 ~/.config/revolut-x/<file>`, `revx configure generate-keypair`, `revx configure set --api-key <key>`). Only escalate to the user for inputs only they can provide: the 64-character API key string, confirmation that they have registered the public key in their Revolut X profile, the keypair passphrase, or approval to overwrite an existing keypair. After the fix, retry the original command.

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

## User Journey: From Install to First Trade

### Step 1: Configure Authentication

```bash
revx configure                 # Interactive setup wizard
```

This will:
1. Generate an Ed25519 keypair (private + public key)
2. Display your public key — copy it
3. Prompt you to register the public key at **exchange.revolut.com -> Profile -> API Keys**
4. Create a new API key — tick the **"Allow usage via Revolut X MCP and CLI"** checkbox
5. Prompt for the 64-character API key you receive after registration

Or do it step-by-step:

```bash
revx configure generate-keypair          # Creates Ed25519 keypair
# Register public key at exchange.revolut.com -> Profile -> API Keys
# Create API key — tick "Allow usage via Revolut X MCP and CLI"
revx configure set --api-key <64-char-key>
```

> **Before trading:** review the security policy — <https://github.com/revolut-engineering/revolut-x-api/security>. Key precautions: run the CLI in a sandbox or dedicated OS user account, use per-purpose API keys (label agent-driven keys "agentic"), keep credential file permissions at `0o600`, and password-protect the private key PEM.

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
revx market tickers BTC-USD            # Single ticker (key-value display)
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

### Behavioral Instructions

#### Human Confirmation Required

**NEVER execute `revx order place` or `revx order cancel` without explicit user confirmation.** These commands move real money.

Before running any order command, present a confirmation summary to the user:

> **Order to place:**
> - Pair: BTC-USD
> - Side: buy
> - Type: limit @ $95,000
> - Size: 0.001 BTC
>
> Shall I proceed?

Only execute after the user explicitly approves (e.g., "yes", "go ahead", "do it").

For `revx order cancel --all`, warn the user that this cancels **every** open order and confirm.

#### Missing Parameters — Always Ask, Never Guess

All required parameters must come from the user. If any are missing, ask for them before building the command.

**Required for every order:**
1. **Symbol** — which pair? (e.g., `BTC-USD`)
2. **Side** — buy or sell?
3. **Size** — how much? (`--qty` for base currency or `--quote` for quote currency)
4. **Order type** — market (`--market`) or limit (`--limit <price>`)?

**Never assume defaults for these parameters.** If the user says "buy some BTC", ask:
- How much? (quantity in BTC or dollar amount)
- Market order or limit? (if limit, at what price?)

Optional flags (`--post-only`) can be omitted unless the user requests them.

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

### Long-Running Command — Background Execution

All `revx monitor <type>` commands run **indefinitely** (polling loops with live dashboard output).

How to handle:

1. Run the command via the shell tool with **background execution enabled** so the assistant is freed immediately while the process runs asynchronously.
2. Periodically read the background task output to monitor status and report key events to the user (alerts triggered, errors).
3. If the user asks to stop, terminate the background process.
4. Also print the command to the user so they can optionally run it in a separate terminal for the full live dashboard experience (with colors, real-time tables, Ctrl+C to stop). Alerts are also sent to Telegram if configured.

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
| `--days <n>` | 3 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above start price) |

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
| `--days <n>` | 3 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above start price) |

Max 200 parameter combinations.

### Run (Live Trading)

#### Human Confirmation Required

**NEVER execute `revx strategy grid run` (without `--dry-run`) without explicit user confirmation.** This command places real orders with real money.

Before launching a live grid bot, present a confirmation summary:

> **Grid bot to launch:**
> - Pair: BTC-USD
> - Investment: $500
> - Levels: 10 per side
> - Range: +/-5%
> - Mode: **LIVE** (real orders)
>
> This will place real buy and sell orders. Shall I proceed?

Only execute after the user explicitly approves. `--dry-run` does **not** require confirmation (no real orders).

#### Always Suggest Dry Run First

When the user asks to run a live grid bot, **always suggest starting with `--dry-run`** before going live — unless the user has already completed a dry run in the current session or explicitly says they want to skip it.

> Before going live, I'd recommend a dry run first to verify the grid setup:
> ```bash
> revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5 --dry-run
> ```
> This simulates the bot without placing real orders. Want to start with a dry run?

If the user confirms they want to skip the dry run, proceed to the live confirmation flow above.

#### Missing Parameters — Always Ask, Never Guess

The `--investment` flag is required by the CLI, but also confirm intent for all key parameters:

1. **Symbol** — which pair?
2. **Investment** — how much capital?
3. **Levels** — how many grid levels per side? (default 5 if user says "use defaults")
4. **Range** — what percentage range? (default 5% if user says "use defaults")
5. **Split mode?** — see "When to Suggest Split" below

If the user says "run a grid bot on BTC", ask for the investment amount at minimum.

#### Long-Running Command — Background Execution

`revx strategy grid run` (including `--dry-run`) runs **indefinitely** as a continuous polling loop.

How to handle:

1. Run the command via the shell tool with **background execution enabled** so the assistant is freed immediately while the process runs asynchronously.
2. Periodically read the background task output to monitor status and report key events to the user (orders placed, fills, errors).
3. If the user asks to stop, terminate the background process.
4. Also print the command to the user so they can optionally run it in a separate terminal for the full live dashboard experience (with colors, real-time tables, Ctrl+C for graceful shutdown).

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
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above current price) |
| `--interval <sec>` | 10 | Polling interval in seconds |
| `--dry-run` | off | Simulate without real orders |
| `--reset` | off | Discard saved state, start fresh |

**Passkey required.** Ctrl+C for graceful shutdown (cancels open orders, prints summary).

**Persistence:** State auto-saved for crash recovery. Clean shutdown deletes state. Crashed sessions auto-reconcile on restart.

If Telegram connectors are configured, notifications are sent on startup, shutdown, fills, and P&L changes (see [Connector (Telegram)](#connector-telegram)).

### When to Suggest Split

When the user sets up a grid strategy (backtest, optimize, or run), **ask whether they want split mode** if they haven't specified `--split`. Present it as a simple choice with context:

> Would you like to use split mode (`--split`)?
> - **Without split** — all capital goes to buy orders below the current price. Best for **uptrending markets** where you expect price to dip into buy levels and bounce back.
> - **With split** — capital is divided across both buy and sell levels. A market buy at the start price funds sell positions above. Best for **ranging/sideways markets** where price oscillates around the current level.

If the user is unsure, recommend running both variants in backtest/optimize to compare results. Use `--split` consistently across backtest, optimize, dry-run, and live when the user has chosen split mode.

### P&L Metrics

- **Realized P&L** — sum of profit from each completed sell (sell revenue − cost per level). Measures pure grid trading profit. The initial split buy (if `--split` is used) does not affect this metric.
- **Total P&L** — `(final quote balance + final base × final price) − initial investment`. The mark-to-market portfolio value change. No assets are force-sold at the end.

**Without `--split`:** only buy levels (below start price) are funded. In uptrending markets all grid cycles may complete, making Realized and Total P&L equal.

**With `--split`:** investment is divided across all levels. Levels above start price get positions via a simulated market buy at start price. This creates Realized/Total P&L divergence and allows profiting from both up and down moves within the grid.

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

### Setup Guide: Getting a Bot Token and Chat ID

When the user wants to set up Telegram notifications, they need a **bot token** and a **chat ID**. If either is missing, walk them through the steps below. Share these as a message the user can follow — these steps require the user's Telegram app and cannot be performed via tools.

**Step 1 — Create a Telegram Bot (to get the bot token):**

1. Open Telegram (mobile or desktop)
2. Search for **@BotFather** and start a chat
3. Send `/newbot`
4. BotFather will ask for a **display name** (e.g., "My RevX Alerts") — type any name
5. BotFather will ask for a **username** ending in `bot` (e.g., `my_revx_alerts_bot`) — must be unique
6. BotFather replies with your bot token — it looks like `123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ`
7. Copy the token and share it back here

**Step 2 — Get your Chat ID:**

1. Open Telegram and find your new bot (search for the username you just created)
2. Send any message to the bot (e.g., "hello")
3. Open this URL in a browser — replace `<YOUR_TOKEN>` with the token from Step 1:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
4. In the JSON response, find `"chat":{"id": <number>}` — that number is your chat ID
5. It's usually a positive number for personal chats (e.g., `123456789`) or a negative number for group chats (e.g., `-1001234567890`)
6. Copy the chat ID and share it back here

**Step 3 — Add the connection (the assistant runs this):**

Once the user provides both values, run:

```bash
revx connector telegram add --token <bot-token> --chat-id <chat-id> --test
```

The `--test` flag sends a test message to verify the connection works. If the test succeeds, the setup is complete.

### Telegram Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `chat not found` or empty `getUpdates` response | The user has not messaged the bot yet | Send any message to the bot, then retry the `getUpdates` URL |
| `Unauthorized` | The token is incorrect | Ask the user to copy the token again from BotFather |
| Group chat ID not appearing | The bot is not in the group, or no message has been sent in the group since adding the bot | Add the bot to the group as a member, then send any message in the group, then retry `getUpdates` |

### How Notifications Work

Once a Telegram connection is configured and enabled:

- **Monitor alerts** (`revx monitor …`) are automatically sent as Telegram messages when triggered.
- **Grid bot events** (`revx strategy grid run`) send notifications on startup, shutdown, fills, and P&L changes.

No additional configuration is needed — active monitors and the grid bot detect enabled Telegram connections automatically.

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
| No private key found | Key file missing at the configured path | Run `revx configure generate-keypair` (then re-register the public key) |
| Authentication failed (401) | Invalid key or signature | Re-register public key at exchange.revolut.com |
| Insecure permissions | Credential file mode is looser than `0o600` | Run `chmod 600 ~/.config/revolut-x/<file>` (e.g. `private.pem`, `config.json`) |
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
