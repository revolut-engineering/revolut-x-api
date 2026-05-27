---
name: revx-strategy
description: >
  Revolut X grid trading strategy. Use when the user asks to "backtest a grid strategy",
  "optimize grid parameters", "run a grid bot", "grid trading", "dry run grid",
  or runs revx strategy grid commands. Grid run is a long-running background process.
---

# Strategy: Grid Bot (`revx strategy grid`)

> Backtest, optimize, and run automated grid trading strategies.

> **Auth required.** Make sure `revx` is installed and configured before running these commands. If any command fails with an auth-related error — `Auth not configured`, `No private key found`, `Authentication failed (401)`, `Invalid signature`, `insecure permissions`, or a missing key/config file at `~/.config/revolut-x/` — **invoke the `revx-auth` skill immediately and apply the fix yourself.** Do not interrupt the user to ask them to run setup. Only escalate to the user for steps only they can perform (pasting the API key, registering the public key in their Revolut X profile, choosing a passphrase). After the fix, retry the original command.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`.

---

## Backtest

Test a grid strategy on historical data:

```bash
revx strategy grid backtest BTC-USD
revx strategy grid backtest BTC-USD --levels 10 --range 10 --investment 1000
revx strategy grid backtest ETH-USD --days 60 --interval 4h
revx strategy grid backtest BTC-USD --split
revx strategy grid backtest BTC-USD --trailing-up --stop-loss 85000
revx strategy grid backtest BTC-USD --json
```

| Flag | Default | Description |
|---|---|---|
| `--levels <n>` | 5 | Grid levels per side (1-25) |
| `--range <pct>` | 10 | Grid range +/- % from mid price |
| `--investment <amount>` | 1000 | Capital in quote currency |
| `--days <n>` | 3 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above start price) |
| `--trailing-up` | off | Simulate grid rebuild when price exits the upper boundary |
| `--stop-loss <price>` | off | Stop backtest when price reaches this absolute value (must be below the lowest grid level) |
| `--prices <spec>` | api | Drive the backtest with a synthetic price sequence instead of fetching real candles. Sources: `api` (default), `file:<path>`, `stdin`, `inline:<csv>` (e.g. `inline:100,102,98`), `gen:<type>?<params>` (`linear`, `sine`, `walk`, `steps`). |
| `--trace` | off | Emit a per-tick trace of strategy reaction (price, fills, position, P&L). With `--json`, emits NDJSON. |
| `--json` | off | Output as JSON |

**Backtest engine assumptions (without `--prices`):** The engine runs on OHLC candles and has no access to intra-candle tick data. Order execution order within each candle is determined by the direction of the candle:

| Candle type | Condition | Assumed price path | Execution order |
|---|---|---|---|
| Bullish | `open <= close` | open → low → high → close | All BUY orders at levels ≥ low, then all SELL orders at levels ≤ high |
| Bearish | `open > close` | open → high → low → close | All SELL orders at levels ≤ high, then all BUY orders at levels ≥ low |

Limitation: real intra-candle price action may be more complex (e.g. multiple touches of high/low), which the backtest does not reproduce. With `--prices` (synthetic source), each price drives the real bot engine tick-by-tick using close price only.

**Not long-running** — completes and returns results. Run normally via the `Bash` tool.

**Always confirm** these key parameters before running: **pair**, **investment**, **levels**, **range**, and **split mode**. These affect capital and strategy behavior — never assume them silently. Other parameters (days, interval) can use defaults unless the user specifies otherwise.

---

## Optimize

Test multiple parameter combinations, ranked by return:

```bash
revx strategy grid optimize BTC-USD
revx strategy grid optimize BTC-USD --investment 5000 --days 60
revx strategy grid optimize BTC-USD --levels 5,10,15,20 --ranges 3,5,10 --top 5
revx strategy grid optimize BTC-USD --split
revx strategy grid optimize BTC-USD --trailing-up --stop-loss 85000
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
| `--trailing-up` | off | Simulate grid rebuild when price exits the upper boundary |
| `--stop-loss <price>` | off | Skip combinations where the stop-loss sits inside the grid; stop each backtest run when price reaches this absolute value |
| `--prices <spec>` | api | Sweep parameters against a synthetic price sequence instead of fetching real candles. Sources: `api` (default), `file:<path>`, `stdin`, `inline:<csv>`, `gen:<type>?<params>`. |
| `--json` | off | Output as JSON |

Max 200 parameter combinations. **Not long-running** — completes and returns results.

**Always confirm** these key parameters before running: **pair**, **investment**, and **split mode**. These affect capital and strategy behavior — never assume them silently. Other parameters (levels list, ranges list, days, interval, top) can use defaults unless the user specifies otherwise.

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
revx strategy grid run BTC-USD --investment 1000 --trailing-up --stop-loss 85000
```

| Flag | Default | Description |
|---|---|---|
| `--investment <amount>` | **required** | Capital in quote currency |
| `--levels <n>` | 5 | Grid levels per side (1-25) |
| `--range <pct>` | 5 | Grid range +/- % from mid |
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above current price) |
| `--interval <sec>` | 10 | Polling interval in seconds |
| `--dry-run` | off | Simulate without real orders |
| `--reset` | off | Discard saved state, start fresh |
| `--trailing-up` | off | Rebuild grid around current price when upper boundary is breached |
| `--stop-loss <price>` | off | Stop bot when price reaches this absolute value (must be below the lowest grid level) |
| `--prices <spec>` | api | **Dry-run only.** Drive the bot with a synthetic price sequence instead of polling the live order book. Sources: `api` (default), `file:<path>`, `stdin`, `inline:<csv>`, `gen:<type>?<params>`, `interactive` (prompt for each tick). Rejected unless `--dry-run` is also set. |
| `--trace` | off | **Dry-run only.** Per-tick trace of the bot's reaction (price, fills, position, open orders, P&L). With `--json`, emits NDJSON. |
| `--json` | off | Output as JSON. Combined with `--trace`, emits NDJSON per-tick records. |

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

## Mock Price Sources (`--prices`)

The `--prices <spec>` flag replaces the live API price stream with a hand-crafted or synthetic sequence. Everything downstream (simulator, order logic, dashboard) is unchanged — only the price source differs.

### Six sources

| Source | Spec | Use |
|---|---|---|
| **Live API** (default) | `api` | Real candles from Revolut X. Honours `--days` and `--interval`. |
| **Inline** | `inline:100,102,98,…` | Comma-separated prices — quickest scenario experiment. |
| **File** | `file:./path.csv` | CSV / JSON / NDJSON file, format auto-detected. |
| **Stdin** | `stdin` | Pipe prices from another process (`seq 100 -1 90 \| revx … --prices stdin`). |
| **Generator** | `gen:walk?…`, `gen:sine?…`, `gen:linear?…`, `gen:steps?…` | Procedurally generated path. Seeded variants are deterministic. |
| **Interactive** | `interactive` | Prompts for each price one at a time — step-debugger for the live bot. `--dry-run` only. |

### Where each source is accepted

| Command | Accepted sources |
|---|---|
| `grid backtest` | `api`, `inline`, `file`, `stdin`, `gen` (`interactive` rejected) |
| `grid optimize` | `api`, `inline`, `file`, `stdin`, `gen` (`--trace` not supported here) |
| `grid run --dry-run` | all six, including `interactive` |
| `grid run` (real orders) | **`api` only** — any other spec is rejected at startup |

### Safety rule

**A synthetic price stream can never drive real orders.** `grid run` rejects any non-`api` spec unless `--dry-run` is also set. This is a hard error, not a warning.

### Synthetic generators (`gen:`)

| Generator | Shape | Required params | Optional params |
|---|---|---|---|
| `gen:linear` | Straight ramp from start to end | `start`, `end`, `steps` | — |
| `gen:sine` | Centre ± amplitude, oscillating | `start`, `amp`, `steps` | `period` (default 24) |
| `gen:walk` | Seeded Gaussian random walk | `start`, `steps` | `sigma` (default 1), `seed` (default 1) |
| `gen:steps` | Step function — each value held for N ticks | `values` (comma-separated, URL-encoded as `%2C`) | `hold` (default 1) |

Examples:
```bash
# Reproducible random walk
revx strategy grid backtest BTC-USD --investment 1000 --prices 'gen:walk?start=100&sigma=2&seed=7&steps=500'

# Regime shift test
revx strategy grid backtest BTC-USD --investment 1000 --prices 'gen:steps?values=100%2C110%2C90%2C105&hold=10'

# Oscillating market
revx strategy grid backtest BTC-USD --investment 1000 --prices 'gen:sine?start=100&amp=10&steps=200'

# Inline crash scenario with trace
revx strategy grid backtest BTC-USD --investment 1000 --prices 'inline:50000,49000,47000,42000,40000,45000' --trace

# Step-by-step dry run
revx strategy grid run BTC-USD --investment 500 --dry-run --prices interactive --trace
```

### Reproducibility

`inline`, `file`, `stdin` — trivially reproducible (fixed input). `gen:linear`, `gen:sine`, `gen:steps` — deterministic by construction. `gen:walk` — deterministic given the same `seed` (mulberry32 PRNG).

---

## When to Suggest Split

When the user sets up a grid strategy (backtest, optimize, or run), **ask whether they want split mode** if they haven't specified `--split`. Present it as a simple choice with context:

> Would you like to use split mode (`--split`)?
> - **Without split** — all capital goes to buy orders below the current price. Best for **uptrending markets** where you expect price to dip into buy levels and bounce back.
> - **With split** — capital is divided across both buy and sell levels. A market buy at the start price funds sell positions above. Best for **ranging/sideways markets** where price oscillates around the current level.

If the user is unsure, recommend running both variants in backtest/optimize to compare results.

Use `--split` consistently across backtest, optimize, dry-run, and live when the user has chosen split mode.

---

## P&L Metrics

**Realized P&L** = sum of profit from each completed sell (sell revenue − cost per level). Measures pure grid trading profit. The initial split buy (if `--split` is used) does not affect this metric.

**Total P&L** = (final quote balance + final base × final price) − initial investment. The mark-to-market portfolio value change. No assets are force-sold at the end.

**Without `--split`:** only buy levels (below start price) are funded. In uptrending markets all grid cycles may complete, making Realized and Total P&L equal.

**With `--split`:** investment is divided across all levels. Levels above start price get positions via a simulated market buy at start price. This creates Realized/Total P&L divergence and allows profiting from both up and down moves within the grid.

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

Use `--split` consistently across all steps if you want to test and run with split investment.

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-telegram` | Get Telegram notifications for grid bot events |
| `revx-market` | Check prices and pair data before configuring a grid |
| `revx-account` | Check balances and order status |
| `revx-trading` | Manual order placement (grid bot places orders automatically) |
| `revx-auth` | API key setup and configuration |
