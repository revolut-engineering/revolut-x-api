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
| `--levels <n>` | 5 | Grid levels per side (1-100) |
| `--range <pct>` | 10 | Grid range +/- % from mid price |
| `--investment <amount>` | 1000 | Capital in quote currency |
| `--days <n>` | 3 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above start price) |
| `--trailing-up` | off | Rebuild when a candle high reaches the second geometric level above the upper boundary, once the grid holds no coins |
| `--stop-loss <price>` | off | Stop backtest when price reaches this absolute value (must be below the lowest grid level) |
| `--json` | off | Output as JSON |

**Backtest engine assumptions :** The engine runs on OHLC candles and has no access to intra-candle tick data. Order execution order within each candle is determined by the direction of the candle:

| Candle type | Condition | Assumed price path | Execution order |
|---|---|---|---|
| Bullish | `open <= close` | open → low → high → close | All BUY orders at levels ≥ low, then all SELL orders at levels ≤ high |
| Bearish | `open > close` | open → high → low → close | All SELL orders at levels ≤ high, then all BUY orders at levels ≥ low |

Limitation: real intra-candle price action may be more complex (e.g. multiple touches of high/low), which the backtest does not reproduce.

Backtests confirm trailing-up from a single qualifying candle high, once the grid holds no coins, and rebuild from that candle's close. Stop-loss also remains immediate because historical candles do not contain live tick sequences.

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
| `--levels <csv>` | 3,5,8,10,15 | Per-side level counts to test (each 1-100) |
| `--ranges <csv>` | 3,5,7,10,12,15,20 | Range percentages to test |
| `--top <n>` | 10 | Top results to display |
| `--investment <amount>` | 1000 | Capital in quote currency |
| `--days <n>` | 3 | Historical data period |
| `--interval <res>` | 1m | Candle resolution |
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above start price) |
| `--trailing-up` | off | Rebuild when a candle high reaches the second geometric level above the upper boundary, once the grid holds no coins |
| `--stop-loss <price>` | off | Stop each backtest run when price reaches this absolute value. It must be below the lowest level of every combination, otherwise optimize fails before running |
| `--json` | off | Output as JSON |

Max 200 parameter combinations. Every combination is validated before any backtest runs. If any combination violates pair constraints or stop-loss placement, the entire optimize command fails; invalid combinations are not skipped. **Not long-running** — completes and returns results.

**Always confirm** these key parameters before running: **pair**, **investment**, and **split mode**. These affect capital and strategy behavior — never assume them silently. Other parameters (levels list, ranges list, days, interval, top) can use defaults unless the user specifies otherwise.

---

## Pair Constraints and Validation

Backtest, optimize, dry-run, and live run all build the same exchange-aware grid plan before execution:

- Grid prices are rounded to the pair's quote step and must remain strictly increasing and unique.
- Quote per level is floored to the quote step; base amounts are floored to the base step.
- Every order must satisfy the pair's minimum quote value and minimum/maximum base size.
- Split mode must fit the initial market buy and each allocated sell amount within the pair limits.
- Stop-loss must be strictly below the lowest aligned grid level, and its maximum liquidation size must not exceed the maximum base order size.

Invalid parameters fail before simulation or order placement. Optimize validates all requested combinations first and fails as a whole if any one is invalid. Increasing levels reduces capital per level, so a 100-level-per-side grid may require a larger investment than a smaller grid.

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
| `--levels <n>` | 5 | Grid levels per side (1-100) |
| `--range <pct>` | 5 | Grid range +/- % from mid |
| `--split` | off | Split investment across buy and sell levels (market-buy base for levels above current price) |
| `--interval <sec>` | 10 | Polling interval in seconds, 5 to 86400 |
| `--dry-run` | off | Simulate without real orders |
| `--reset` | off | Cancel the saved grid's orders and start fresh. The old grid's coins stay in the wallet |
| `--trailing-up` | off | Rebuild after 3 consecutive ticks reach the second geometric level above the upper boundary, once the grid holds no coins |
| `--stop-loss <price>` | off | Sell everything and stop when price reaches this absolute value (must be below the lowest grid level) |

Ctrl+C ends the grid: it cancels open orders, keeps the coins in the wallet and prints a summary. The next start begins a new grid. If an order isn't confirmed closed, the next start checks it first. A stop signal (`kill`, `docker stop`, a system shutdown) cancels the orders and keeps the grid while it holds coins or an order isn't confirmed. After that or a crash, the next start resumes it.

If an order can't be placed, for example because coins or cash were moved out of the account after a fill, the dashboard shows a line for it with the reason on every check until it goes out. Orders of one level waiting for the same reason share a line, and an order the bot sent but couldn't confirm shows as not confirmed yet. One that came back rejected shows as rejected or already placed while the bot looks for it. A sell the bot hasn't sent yet shows as not placed yet. An order the exchange hasn't listed for a minute shows as not listed yet. The Open buy fills row shows what open buys have bought so far. Warnings about the current check, such as a rejected order, come first. Telegram gets one message for that order if it still isn't out at the end of the check, so a retry that works within the same check sends nothing. A sell is retried on every check unless its reply was lost. A buy is retried once a minute, as soon as there is cash for it. Neither sends further messages until that order was placed and later fails again. Buys skipped for lack of cash show as one line with how many wait, the free cash and the total they need. A level is refilled by the money it is missing, so a lost leftover is topped up by its own amount, and the bot places what the free cash allows. If the reply to a buy or sell is lost, the bot looks for its ID in the open orders on every check and in the order history once a minute, and tracks the order once it shows up. If two lookups miss it, the bot sends it again with the same ID. If the order already exists, the exchange answers that send as rejected or refuses it, and the bot keeps looking. If it turns out cancelled, the bot places it again at the same amount. One that only shows up as rejected is handled like a rejected grid order, described below. A leftover below the exchange minimum is not placed. It stays in its position's budget and is bought back when that position is sold, unless that re-buy is also below the minimum. The same happens to a leftover buy cancelled on Ctrl+C or found cancelled at start-up. With `--split`, the start-up size check counts the 0.09% fee the market buy pays in coins, so a grid at the exchange minimum is refused before it buys.

`--reset` starts a new grid even when the old one holds coins or has a pending sell-off. It first cancels the old grid's orders, one sent with a lost reply included, then deletes the save. The sell-off is dropped, and any coins the old grid bought and didn't sell stay in the wallet, outside the new grid. If a cancel isn't confirmed or the orders can't be listed, the save is kept, so run it again. An order the exchange doesn't list is named with its ID. A split buy or sale sent just before may still trade for a few minutes.

If the saved grid file is damaged, the bot refuses to start, so the old grid's orders and coins are not left untracked. A new grid can't take them over, so first cancel the old grid's open orders in the Revolut X app and decide what to do with its coins. Then running with `--reset` renames the damaged file to `<name>.damaged-<time>` (it is never deleted) and starts a new grid. A file the bot isn't allowed to read is reported as a read error, not as damaged.

Live and dry-run trailing-up requires three consecutive qualifying prices. A price below the threshold resets confirmation. When the third price arrives, the grid must also hold no coins and have no unresolved order placement. Otherwise the rebuild waits, and the next price at or above the threshold tries again. Stop-loss remains immediate on the first qualifying price.

Grid orders are plain limit orders (`allow_taker`). An order the market has already passed, such as a sell below the price after a fast rise or a buy above it after a fast drop, fills at once at its price or better and pays the 0.09% taker fee. Orders that wait on the book pay the 0% maker fee. The grid stays tied to its levels. A buy's sell goes one level up for the coins received, rounded down to the exchange's size step. A leftover too small to sell is closed with that sale and its cost is charged to it. A filled sell re-buys the level its coins were bought on for the amount that slot held, which is the full per-level amount, or its share after partial fills. An empty buy level below the grid's centre price gets its buy back even when the price is already below it, and that buy fills at once. If the exchange answers a grid order with `state: "rejected"`, whatever the reject reason, the bot keeps the order's client order ID and sends nothing in its place at once. The reply carries no reason, and a re-send of an order that is already on the book comes back rejected too. So the bot looks for that ID in the open orders on every check and in the order history once a minute. An open or traded order with that ID is tracked, anything it traded is booked, and the rejected copy is ignored. Only if no open or traded order with that ID shows up within 5 minutes does it count as one rejection for its buy level or position, and the bot places it again with a new client order ID, a buy at its own amount. A tracked order that the exchange later reports as rejected with nothing traded is looked up the same way. The count carries over between checks but not across a restart. Other errors in between don't reset it, and neither does an accepted order. It starts again only once a later order of that level or position is seen on the book or filled. The third rejection sells everything and stops the bot (emergency stop, see below), so three rejections in a row take about 15 minutes. Rejections found during a sell-off are not counted, and trailing up starts every count again. Other errors are not re-sent right away. They are retried on later checks. An order the exchange doesn't list yet, at startup or while running, stays tracked and is looked up again. Once it has been missing for 5 minutes it is sent again under its own client order ID, so the exchange can't place it twice. Its cancel isn't counted as done until then either. An order from an older save whose client order ID the bot can't find is not sent again. The bot sends a message, and only once it has been missing for 24 hours does it place a new order, with one more message. Trailing up waits until then. On startup, a buy or sell that was sent but never confirmed is looked up by its client order ID across the grid's order history. An open or filled order is adopted, even when a rejected copy has the same ID, and a cancelled one with no fill is placed again with a new ID, a buy at its own amount. One found only as rejected is looked up for 5 minutes as above. An order that can't be found is re-sent with its original ID. If that send fails, startup goes on with an alert. The bot then looks it up once a minute and sends it again with the same ID when two lookups miss it, a buy only when there is cash for it. If the exchange answers that send as rejected or already placed, the bot doesn't send that ID again and looks it up for 5 minutes as above. A send that fails while restoring the buys or split sells of an interrupted first placement doesn't stop startup either. While running, the same lookup runs once a minute for every unconfirmed buy, and for a sell whose reply was lost or that came back rejected. It reads the order history from a day before the order was first sent. A split market buy whose reply was lost is looked up the same way at startup before it is sent again. If the exchange has it but doesn't list it yet, startup stops and asks to start again in a few minutes.

**Fees in the grid:** the fee is taken from what each order receives. A grid buy pays its fee in coins, so the position holds the coins that actually arrived and its cost is the quote actually spent. The sell for that position is sized to those net coins. A grid sell pays its fee in the quote currency, so its profit is the quote that actually arrived minus the position's cost. The bot reads the real fee from every filled order and adds it to "Fees Paid" in the quote currency, converting a coin fee at the fill price. Orders that rest on the book pay the 0% maker fee. These pay the 0.09% taker fee: a grid order that fills at once because the market already passed it, the split start-up market buy, and the market sales of a sell-off. Dry-run and backtests assume 0% for grid fills and 0.09% for the split buy and the sell-off.

**Selling everything (stop-loss and emergency stop):** the bot first marks the sell-off in the saved state. It finishes any earlier sale and checks orders that were sent but never confirmed, then cancels every grid order and books anything that traded in the meantime. It then sells all held coins with market orders, in pieces no larger than the exchange maximum. A sale that fills nothing is retried, up to 3 times. A sale that fails to place leaves the sell-off pending. Coins behind an order whose cancel can't be confirmed are not sold. An order whose reply was lost, the split buy included, is looked up by its ID, and the coins it may hold are neither sold nor written off until it is found. While such an order, a grid order the exchange doesn't list yet, a cancel or sale that isn't confirmed, or an exchange error holds up the sale, the sell-off checks again every 30 seconds in the same run, for up to 6 minutes. An order missing for 5 minutes is treated as never placed and the sale goes on. An amount below the exchange minimum stays in the wallet and is booked as a loss. When everything is sold, the saved grid is deleted, so the next run starts fresh without `--reset`. If the sell-off can't finish, it stays pending, its message ends with the reason, and it is completed first on the next start, in the same live or dry-run mode. `--reset` drops it instead. Ctrl+C never sells. It stops the wait above, sends no new grid order and waits for a start-up already under way. Outside a sell-off, it then cancels the grid's orders, keeps the coins and ends the grid. A sale already sent during a sell-off finishes, no new one starts, and the rest of the sell-off finishes on the next start.

The dashboard displays at most 24 grid rows in a price-centred window and reports how many higher and lower levels are hidden, so 100-level-per-side grids remain readable.

If Telegram connectors are configured (see `revx-telegram` skill), notifications are sent on startup, shutdown, fills, and P&L changes.

**One run per grid:** a grid run, live or dry, holds a lock file next to its saved state (`grid_state_<PAIR>.lock` in the config folder). A second run of the same pair from the same config folder, `--reset` included, is refused before it sends anything while the first one runs. A lock left on this machine by a run that crashed is taken over, also after a restart of the machine. Otherwise the error names the lock file to delete. Use one config folder per running machine or container. Two containers that share a host name and a config folder can each start the same grid, because neither sees the other's process. Never start a second copy of a grid to check on it, run `revx order open` instead. Never delete a lock file unless the user confirms no grid process is running.

**Outages and outside changes:** a key the exchange refuses (401 or 403) gets one Telegram message at once that names the masked key, and one more when it works again. The dashboard says how to fix it, and open grid orders stay on the exchange meanwhile. After a 401, fix the key with `revx configure` and start the grid again. After a 403, fix the key's permissions in Revolut X and the grid goes on by itself. After 5 minutes without prices or order data for any other reason, a grid sends one Telegram message, and one more when data is back. It keeps running meanwhile. A grid order cancelled outside the bot, for example in the app, is placed again, and the dashboard says how many and when. If one is replaced outside the bot, the grid places its own again. The dashboard, the restart summary and the stop message say the replacement is not tracked, so cancel it with `revx order cancel` if it isn't wanted.

### Long-Running Command — Behavioral Instructions for Claude

`revx strategy grid run` (including `--dry-run`) runs **indefinitely** as a continuous polling loop.

**How to handle:**

1. Run the command using the `Bash` tool with `run_in_background: true` — this frees Claude immediately while the process runs asynchronously
2. Periodically read the background task output file with the `Read` tool to monitor status and report key events to the user (orders placed, fills, errors)
3. If the user asks to stop, end the grid the way Ctrl+C does: run `pkill -INT -f "revx strategy grid run <PAIR>"`, then read the output until the stop summary appears. Use the `TaskStop` tool only if that fails, because it keeps the grid for the next start
4. Only one copy of a grid can run. If the user would rather watch the live dashboard (colors, real-time tables, Ctrl+C to stop), give them the command to run in their own terminal instead of starting it in the background. Never do both

**Example — starting a grid bot:**

Bash tool call:
```json
{ "command": "revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5", "run_in_background": true }
```

Response to user:

> Started grid bot for BTC-USD in the background. I'll check for updates periodically, and I can stop it whenever you want.
>
> If you'd rather watch the live dashboard yourself, I can stop this run, and you start the same command in your own terminal. Only one copy of a grid can run at a time.

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

**Realized P&L** = sum of profit from each completed sell (sell revenue − cost per level). Measures pure grid trading profit. The split buy (if `--split` is used) books no profit itself, but its cost, including the 0.09% fee paid in coins, is the cost of the coins it bought, so it counts when those coins are sold.

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
