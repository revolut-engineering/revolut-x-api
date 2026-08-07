---
name: revx-strategy-martingale
description: >
  Revolut X martingale DCA trading strategy. Use when the user asks to "backtest a martingale strategy",
  "optimize martingale parameters", "run a martingale bot", "martingale DCA", "dry run martingale",
  or runs revx strategy martingale commands. Martingale run is a long-running background process.
---

# Strategy: Martingale Bot (`revx strategy martingale`)

> Backtest, optimize, and run automated martingale DCA trading strategies.

> **Auth required.** Make sure `revx` is installed and configured before running these commands. If any command fails with an auth-related error — `Auth not configured`, `No private key found`, `Authentication failed (401)`, `Invalid signature`, `insecure permissions`, or a missing key/config file at `~/.config/revolut-x/` — **invoke the `revx-auth` skill immediately and apply the fix yourself.** Do not interrupt the user to ask them to run setup. Only escalate to the user for steps only they can perform (pasting the API key, registering the public key in their Revolut X profile, choosing a passphrase). After the fix, retry the original command.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`.

---

## Backtest

Test a martingale strategy on historical data:

```bash
revx strategy martingale backtest BTC-USD
revx strategy martingale backtest BTC-USD --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15 --investment 1000
revx strategy martingale backtest ETH-USD --days 60 --interval 4h
revx strategy martingale backtest BTC-USD --json
```

| Flag | Default | Description |
|---|---|---|
| `--price-deviation <pct>` | 2 | % price drop between consecutive buy levels |
| `--scale <n>` | 2.0 | Capital multiplier per safety order (e.g. 2 = each order 2× larger) |
| `--max-safety-orders <n>` | 5 | Maximum number of safety orders (0–30) |
| `--take-profit <pct>` | 1.5 | % above average entry price to place the TP sell |
| `--stop-loss <pct>` | 15 | % below current price to trigger stop-loss (recomputed each cycle) |
| `--investment <amount>` | 1000 | Capital in quote currency |
| `--days <n>` | 3 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |
| `--json` | off | Output as JSON |

**Backtest engine assumptions :** The engine runs on OHLC candles and has no access to intra-candle tick data. Order execution order within each candle is determined by the direction of the candle:

| Candle type | Condition | Assumed price path | Execution order |
|---|---|---|---|
| Bullish | `open <= close` | open → low → high → close | All BUY orders at levels ≥ low, then TP/SL check |
| Bearish | `open > close` | open → high → low → close | TP/SL check first, then all BUY orders at levels ≥ low |

Limitation: real intra-candle price action may be more complex (e.g. multiple touches of high/low), which the backtest does not reproduce.

**Not long-running** — completes and returns results. Run normally via the `Bash` tool.

**Always confirm** these key parameters before running: **pair**, **investment**, **price-deviation**, **scale**, **max-safety-orders**, **take-profit**, and **stop-loss**. These affect capital and strategy behavior — never assume them silently. Other parameters (days, interval) can use defaults unless the user specifies otherwise.

---

## Optimize

Test multiple parameter combinations, ranked by return:

```bash
revx strategy martingale optimize BTC-USD
revx strategy martingale optimize BTC-USD --investment 5000 --days 60 --stop-loss 15
revx strategy martingale optimize BTC-USD --price-deviation 1,1.5,2,2.5,3 --scale 1.5,2,2.5 --max-safety-orders 3,5,7 --take-profit 1,1.5,2,2.5 --top 5
revx strategy martingale optimize BTC-USD --interval 4h --days 30
```

| Flag | Default | Description |
|---|---|---|
| `--price-deviation <csv>` | 1,1.5,2,2.5,3 | Price deviation % values to test |
| `--scale <csv>` | 1.5,2.0,2.5 | Safety order volume scale values to test |
| `--max-safety-orders <csv>` | 3,5,7 | Max safety order counts to test |
| `--take-profit <csv>` | 1,1.5,2,2.5 | Take profit % values to test |
| `--stop-loss <pct>` | 15 | Fixed stop-loss % applied to all combinations |
| `--top <n>` | 10 | Top results to display |
| `--investment <amount>` | 1000 | Capital in quote currency |
| `--days <n>` | 3 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |
| `--json` | off | Output as JSON |

Max 200 combinations. Combinations where the stop-loss is too tight (would sit inside the order levels) are skipped automatically.

**Not long-running** — completes and returns results.

**Always confirm** these key parameters before running: **pair**, **investment**, and **stop-loss**. These affect capital and strategy behavior — never assume them silently. Other parameters (days, interval, top) can use defaults unless the user specifies otherwise.

---

## Run (Live Trading)

### Human Confirmation Required

**NEVER execute `revx strategy martingale run` (without `--dry-run`) without explicit user confirmation.** This command places real orders with real money.

Before running a live martingale bot, present a confirmation summary to the user:

> **Martingale bot to launch:**
> - Pair: BTC-USD
> - Investment: $1000
> - Price Deviation: 2%
> - Scale: 2.0
> - Max Safety Orders: 3
> - Take Profit: 1.5%
> - Stop Loss: 15%
> - Mode: **LIVE** (real orders)
>
> This will place real buy and sell orders. Shall I proceed?

Only execute after the user explicitly approves. `--dry-run` does **not** require confirmation (no real orders).

### Always Suggest Dry Run First

When the user asks to run a live martingale bot, **always suggest starting with `--dry-run`** before going live — unless the user has already completed a dry run in the current session or explicitly says they want to skip it.

Example response:

> Before going live, I'd recommend a dry run first to verify the martingale setup:
> ```bash
> revx strategy martingale run BTC-USD --investment 1000 --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15 --dry-run
> ```
> This simulates the bot without placing real orders. Want to start with a dry run?

If the user confirms they want to skip the dry run, proceed to the live confirmation flow above.

### Missing Parameters — Always Ask, Never Guess

The `--investment` flag is required by the CLI, but also confirm the user's intent for all key parameters:

1. **Symbol** — which pair?
2. **Investment** — how much capital?
3. **Price deviation** — % drop between levels? (default 2% if user says "use defaults")
4. **Scale** — capital multiplier per safety order? (default 2.0 if user says "use defaults")
5. **Max safety orders** — how many safety levels? (default 5 if user says "use defaults")
6. **Take profit** — TP % above average entry? (default 1.5% if user says "use defaults")
7. **Stop loss** — SL % below current price? (default 15% if user says "use defaults")

If the user says "run a martingale bot on BTC", ask for the investment amount at minimum.

Run a live martingale bot with real-time dashboard:

```bash
revx strategy martingale run BTC-USD --investment 1000
revx strategy martingale run BTC-USD --investment 1000 --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15
revx strategy martingale run BTC-USD --investment 1000 --dry-run
revx strategy martingale run BTC-USD --investment 1000 --reset
revx strategy martingale run BTC-USD --investment 1000 --interval 15
```

| Flag | Default | Description |
|---|---|---|
| `--investment <amount>` | **required** | Capital in quote currency |
| `--price-deviation <pct>` | 2 | % price drop between safety order levels |
| `--scale <n>` | 2.0 | Capital multiplier per safety order |
| `--max-safety-orders <n>` | 5 | Max safety orders (0–30) |
| `--take-profit <pct>` | 1.5 | TP % above average entry price |
| `--stop-loss <pct>` | 15 | SL % below current price (recomputed each new cycle) |
| `--interval <sec>` | 10 | Polling interval in seconds |
| `--dry-run` | off | Simulate without real orders |
| `--reset` | off | Discard saved state, start fresh |

Ctrl+C for graceful shutdown (cancels open orders, prints summary).

**Persistence:** State auto-saved for crash recovery. Clean shutdown deletes state. Crashed sessions auto-reconcile on restart.

If Telegram connectors are configured (see `revx-telegram` skill), notifications are sent on startup, shutdown, fills, and P&L changes.

### Long-Running Command — Behavioral Instructions for Claude

`revx strategy martingale run` (including `--dry-run`) runs **indefinitely** as a continuous polling loop.

**How to handle:**

1. Run the command using the `Bash` tool with `run_in_background: true` — this frees Claude immediately while the process runs asynchronously
2. Periodically read the background task output file with the `Read` tool to monitor status and report key events to the user (orders placed, fills, TP hits, SL triggers, errors)
3. If the user asks to stop, use the `TaskStop` tool with the task ID
4. Also print the command to the user so they can optionally run it in a separate terminal for the full live dashboard experience (with colors, real-time tables, Ctrl+C to stop)

**Example — starting a martingale bot:**

Bash tool call:
```json
{ "command": "revx strategy martingale run BTC-USD --investment 1000 --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15", "run_in_background": true }
```

Response to user:

> Started martingale bot for BTC-USD in the background. I'll check for updates periodically.
>
> If you'd like to see the live dashboard, run this in a separate terminal:
> ```bash
> revx strategy martingale run BTC-USD --investment 1000 --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15
> ```
> Press Ctrl+C to stop (gracefully cancels open orders).

---

## P&L Metrics

**Realized P&L** = sum of profit from each completed TP or SL exit (sell revenue − total position cost). Measures pure martingale trading profit.

**Total P&L** = (Realized P&L) + (open position marked to last close price − open position cost). The mark-to-market portfolio value change. No assets are force-sold at the end.

**Stop-loss is % of current price** — not an absolute price. At each new cycle start (after a TP or at bot startup), the SL is computed as `currentPrice × (1 − SL%)`. This means the SL adjusts upward with price after each profitable cycle.

---

## Common Workflow: Backtest Then Run

```bash
# 1. Optimize to find best parameters
revx strategy martingale optimize BTC-USD --investment 1000 --days 30 --stop-loss 15

# 2. Backtest the top result
revx strategy martingale backtest BTC-USD --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15 --investment 1000

# 3. Dry run first
revx strategy martingale run BTC-USD --investment 1000 --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15 --dry-run

# 4. Go live
revx strategy martingale run BTC-USD --investment 1000 --price-deviation 2 --scale 2 --max-safety-orders 3 --take-profit 1.5 --stop-loss 15
```

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-strategy-grid` | Grid trading strategy (alternative automated strategy) |
| `revx-telegram` | Get Telegram notifications for martingale bot events |
| `revx-market` | Check prices and pair data before configuring the bot |
| `revx-account` | Check balances and order status |
| `revx-trading` | Manual order placement (martingale bot places orders automatically) |
| `revx-auth` | API key setup and configuration |
