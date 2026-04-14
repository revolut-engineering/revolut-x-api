---
name: revx-strategy
description: >
  Revolut X grid trading strategy. Use when the user asks to "backtest a grid strategy",
  "optimize grid parameters", "run a grid bot", "grid trading", "dry run grid",
  or runs revx strategy grid commands. Grid run is a long-running background process.
---

# Strategy: Grid Bot (`revx strategy grid`)

> Backtest, optimize, and run automated grid trading strategies.

Ensure `revx` is installed and configured — see `revx-auth` skill.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`.

---

## Backtest

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

**Not long-running** — completes and returns results. Run normally via the `Bash` tool.

---

## Optimize

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

Max 200 parameter combinations. **Not long-running** — completes and returns results.

---

## Run (Live Trading)

### Human Confirmation Required

**NEVER execute `revx strategy grid run` (without `--dry-run`) without explicit user confirmation.** This command places real orders with real money.

Before running a live grid bot, present a confirmation summary to the user:

> **Grid bot to launch:**
> - Pair: BTC-USD
> - Investment: $500
> - Levels: 10 per side
> - Range: +/-5%
> - Mode: **LIVE** (real orders)
>
> This will place real buy and sell orders. Shall I proceed?

Only execute after the user explicitly approves. `--dry-run` does **not** require confirmation (no real orders).

### Always Suggest Dry Run First

When the user asks to run a live grid bot, **always suggest starting with `--dry-run`** before going live — unless the user has already completed a dry run in the current session or explicitly says they want to skip it.

Example response:

> Before going live, I'd recommend a dry run first to verify the grid setup:
> ```bash
> revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5 --dry-run
> ```
> This simulates the bot without placing real orders. Want to start with a dry run?

If the user confirms they want to skip the dry run, proceed to the live confirmation flow above.

### Missing Parameters — Always Ask, Never Guess

The `--investment` flag is required by the CLI, but also confirm the user's intent for all key parameters:

1. **Symbol** — which pair?
2. **Investment** — how much capital?
3. **Levels** — how many grid levels per side? (default 5 if user says "use defaults")
4. **Range** — what percentage range? (default 5% if user says "use defaults")

If the user says "run a grid bot on BTC", ask for the investment amount at minimum.

Run a live grid bot with real-time dashboard:

```bash
revx strategy grid run BTC-USD --investment 500
revx strategy grid run BTC-USD --levels 10 --range 5 --investment 1000 --interval 15
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

Ctrl+C for graceful shutdown (cancels open orders, prints summary).

**Persistence:** State auto-saved for crash recovery. Clean shutdown deletes state. Crashed sessions auto-reconcile on restart.

If Telegram connectors are configured (see `revx-telegram` skill), notifications are sent on startup, shutdown, fills, and P&L changes.

### Long-Running Command — Behavioral Instructions for Claude

`revx strategy grid run` (including `--dry-run`) runs **indefinitely** as a continuous polling loop.

**How to handle:**

1. Run the command using the `Bash` tool with `run_in_background: true` — this frees Claude immediately while the process runs asynchronously
2. Periodically read the background task output file with the `Read` tool to monitor status and report key events to the user (orders placed, fills, errors)
3. If the user asks to stop, use the `TaskStop` tool with the task ID
4. Also print the command to the user so they can optionally run it in a separate terminal for the full live dashboard experience (with colors, real-time tables, Ctrl+C to stop)

**Example — starting a grid bot:**

Bash tool call:
```json
{ "command": "revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5", "run_in_background": true }
```

Response to user:

> Started grid bot for BTC-USD in the background. I'll check for updates periodically.
>
> If you'd like to see the live dashboard, run this in a separate terminal:
> ```bash
> revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5
> ```
> Press Ctrl+C to stop (gracefully cancels open orders).

---

## Common Workflow: Backtest Then Run

```bash
# 1. Optimize to find best parameters
revx strategy grid optimize BTC-USD --investment 1000 --days 30

# 2. Backtest the top result
revx strategy grid backtest BTC-USD --levels 10 --range 7 --investment 1000

# 3. Dry run first
revx strategy grid run BTC-USD --investment 1000 --levels 10 --range 7 --dry-run

# 4. Go live
revx strategy grid run BTC-USD --investment 1000 --levels 10 --range 7
```

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-telegram` | Get Telegram notifications for grid bot events |
| `revx-market` | Check prices and pair data before configuring a grid |
| `revx-account` | Check balances and order status |
| `revx-trading` | Manual order placement (grid bot places orders automatically) |
| `revx-auth` | API key setup and configuration |
