# revolut-x cli

Command-line interface for [Revolut X Public Trading API](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api). Trade crypto from your terminal.

[![npm](https://img.shields.io/npm/v/revolutx-cli)](https://www.npmjs.com/package/@revolut/revolut-x-cli)
[![Node.js](https://img.shields.io/node/v/revolutx-cli)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

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
  - [transaction](#transaction)
  - [monitor](#monitor)
  - [strategy](#strategy)
  - [connector](#connector)
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
revx monitor price BTC-USD --threshold 100000           # Alert when price is above
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
revx market currencies --filter BTC,USD # Specific currencies by code
revx market pairs                       # Trading pairs with size and price steps
revx market pairs --filter BTC-USD,ETH-USD  # Filter by pairs
revx market tickers                     # All tickers
revx market tickers --symbols BTC-USD,ETH-USD  # Filter by pairs
revx market ticker BTC-USD              # Single pair ticker (alias of tickers)
revx market candles BTC-USD             # OHLCV candles (default 1h, the last 100)
  --interval 1h                         # Resolution: 1m 5m 15m 30m 1h 4h 1d 2d 4d 1w 2w 4w
  --since 7d                            # Start, local time (relative 7d 1w 4h 30m today yesterday, ISO or epoch ms)
  --until today                         # End, local time (same formats)
revx market orderbook BTC-USD           # Order book snapshot (50 levels per side)
  --limit 192                           # Depth per side, 1–192 (default 50, out-of-range values error)
```

A `--until` in the future counts as now. One request returns at most 50,000 candles, the latest ones in the range. With `--json`, notes such as this one go to stderr, so stdout stays valid JSON.

---

### order

```bash
# Place orders
revx order place BTC-USD buy --qty 0.001 --limit 95000    # Limit buy (base qty)
revx order place BTC-USD buy --quote 100 --market         # Market buy (quote amount)
revx order place BTC-USD sell --qty 0.001 --market        # Market sell (base qty)
revx order place BTC-USD buy --qty 0.001 --limit 95000 --post-only
revx order place BTC-USD buy --qty 0.001 --limit 95000 --time-in-force ioc
  --time-in-force gtc|ioc               # Limit orders only, gtc by default
  --post-only                           # Limit orders only, cannot combine with ioc
  --client-order-id <uuid>              # Optional idempotency key (random UUID if omitted)

# Place conditional (stop) orders — activate at trigger price, then market or limit execution
revx order place BTC-USD sell --qty 0.001 --conditional --trigger-price 100000
revx order place BTC-USD buy --qty 0.001 --conditional --trigger-price 90000 --trigger-limit-price 89900
  --trigger-price <price>               # Price that activates the order
  --trigger-limit-price <price>         # Optional limit price on trigger (market when omitted)

# Place take-profit / stop-loss orders (trigger directions derived from side)
revx order place BTC-USD sell --qty 0.001 --tp 110000 --sl 90000
revx order place BTC-USD sell --qty 0.001 --tp 110000 --tp-limit 109900
  --tp <price>                          # Take-profit trigger price
  --sl <price>                          # Stop-loss trigger price (at least one of --tp/--sl)
  --tp-limit <price>                    # Optional limit price for the TP leg
  --sl-limit <price>                    # Optional limit price for the SL leg

# View orders
revx order open                         # Active orders (alias: active)
  --symbols BTC-USD,ETH-USD             # Filter by pairs
  --order-states pending_new,new        # States: pending_new new partially_filled
  --order-types limit,conditional       # Types: limit conditional tpsl
  --side buy                            # Filter by side
  --limit 50                            # Max results
revx order history                      # Historical orders
  --symbols BTC-USD,ETH-USD             # Filter by pairs
  --order-states filled,cancelled       # States: filled cancelled rejected replaced partially_filled
  --order-types market,limit            # Types: market limit
  --start-date 7d                       # Start, local time (relative 7d 1w today, ISO or epoch ms)
  --end-date today                      # End, local time
  --limit 50                            # Max results
revx order get <order-id>               # Get specific order details
revx order fills <order-id>             # Get fills for an order

# Replace orders (at least one flag required; only passed fields change)
revx order replace <order-id> --price 96000     # Update the limit price (a buy keeps its quote amount, qty recalculated)
revx order replace <order-id> --qty 0.002       # Update base qty (amount recalculated)
revx order replace <order-id> --quote 150       # Update quote amount (qty recalculated)
revx order replace <order-id> --time-in-force ioc
revx order replace <order-id> --post-only       # Maker-only execution
revx order replace <order-id> --allow-taker     # Allow taking liquidity
revx order replace <order-id> --trigger-price 100000 --trigger-limit-price 99500   # Replace conditional trigger (whole trigger)
revx order replace <order-id> --tp 115000 --tp-limit 114900 --sl 90000             # Replace TP/SL triggers (whole triggers)
revx order replace <order-id> --sl none         # Remove the stop-loss leg (none/null = explicit removal)
  --client-order-id <uuid>              # Optional, random UUID if omitted

# Cancel orders
revx order cancel <order-id>            # Cancel a specific order
revx order cancel --all                 # Cancel all open orders
  --json                                # {"cancelled": "<order-id>"}, or {"cancelled": "all"}
```

**Checks before sending:** `--qty`, `--quote`, `--limit` and `--price` must be positive numbers. A limit price must be a multiple of the pair's price step, shown by `revx market pairs`. Otherwise the order is refused before it is sent, and the message names the nearest valid prices.

**Results:** a placed order prints its state. An order the exchange rejected or cancelled at once exits 1 with the reason. An IOC or market order that closes at once is only a warning, since it cancels whatever it can't fill straight away.

**Lost reply:** every order carries a client order ID. If the reply is lost or the exchange answers with a server error, the command exits 1, says the order may have been placed and prints that ID. Look for it in `revx order open` or `revx order history` first. Retry only with the same `--client-order-id`, which the exchange refuses if the first one went through. Scripts should pass their own `--client-order-id`, since `--json` prints nothing on stdout in this case.

---

### trade

```bash
revx trade private BTC-USD              # My private trade history (alias: history)
  --start-date 7d                       # Start, local time (relative 7d 1w today, ISO or epoch ms)
  --end-date today                      # End, local time
  --limit 50                            # Max results
revx trade public BTC-USD               # All public trades for a pair (alias: all)
  --start-date 7d
  --end-date today
  --limit 50
```

---

### transaction

```bash
revx transaction list                           # Transactions from the last 30 days
  --start-date 7d                               # Start, local time
  --end-date today                              # End, local time
  --types buy,receive                           # Types: buy sell send receive
  --statuses completed,pending                  # Statuses: pending completed cancelled failed reverted
  --currencies BTC,USD                          # Filter by either transaction side
  --limit 100                                   # Max results
  --json                                        # Raw API fields as JSON
revx transaction get <transaction-id>           # Full details of one transaction
  --json                                        # Raw API fields as JSON
```

Table output shows signed `Source Amount` and `Destination Amount` values. Either side can be empty: buys and sells show both sides, sends and stakes only the source, receives, rewards, and un_stakes only the destination. In JSON output each leg carries `account.type` (revolut, revolut_x, external_fiat, external_crypto). The table omits account fields. `revx transaction get` adds account display names and crypto addresses, and shows both sides for receives and sends too (stakes always show only the source, un_stakes and rewards only the destination).

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

All monitor subcommands accept `--interval <sec>` (5 to 86400, default `10`).

Threshold monitors (price, RSI, Bollinger, spread, OBI and the others) alert as soon as the condition holds, also at start. `ema-cross` and `macd` alert only on a fresh crossover after the first check, at most once per hourly candle. After an alert, each check while the condition still holds shows a short "still met" line. "Notified" appears only when at least one message was delivered. A key the exchange refuses (401 or 403) gets one message at once, and one more when it works again. After a 401, fix the key with `revx configure` and start the monitor again. After a 403, fix the key's permissions in Revolut X and the monitor goes on by itself. After 5 minutes without data for any other reason, a monitor sends one message, and one more when data is back, saying how long it lasted.

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
| `--levels <n>` | Grid levels per side | `5` |
| `--range <pct>` | Grid range as % (e.g. `10` for ±10%) | `10` |
| `--investment <amount>` | Capital in quote currency | `1000` |
| `--days <n>` | Days of historical data | `3` |
| `--interval <res>` | Candle resolution (`1m` `5m` `15m` `30m` `1h` `4h` `1d`) | `1m` |
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
| `--days <n>` | Days of historical data | `3` |
| `--interval <res>` | Candle resolution | `1m` |
| `--levels <csv>` | Level counts to test (comma-separated) | `3,5,8,10,15` |
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
| `--levels <n>` | Grid levels per side (total levels = 2×n) | `5` |
| `--range <pct>` | Grid range as % (e.g. `5` for ±5%) | `5` |
| `--split` | Market-buy 50% of investment at start | — |
| `--interval <sec>` | Polling interval in seconds, 5 to 86400 | `10` |
| `--dry-run` | Simulate without placing real orders | — |
| `--trailing-up` | Rebuild after 3 consecutive prices reach the second geometric level above the grid, once the grid holds no coins | — |
| `--stop-loss <price>` | Sell everything and stop when price reaches or falls below this value | — |

Live and dry-run trailing-up requires three consecutive qualifying prices. A price below the threshold resets confirmation. When the third price arrives, the grid must also hold no coins and have no unresolved order placement. Otherwise the rebuild waits, and the next price at or above the threshold tries again. Historical backtests use one qualifying candle high and rebuild from that candle's close. Stop-loss remains immediate in every mode.

Grid orders are plain limit orders (`allow_taker`). An order the market has already passed, such as a sell below the price after a fast rise or a buy above it after a fast drop, fills at once at its price or better and pays the 0.09% taker fee. Orders that wait on the book pay the 0% maker fee. The grid stays tied to its levels. A buy's sell goes one level up for the coins received, rounded down to the exchange's size step. A leftover too small to sell is closed with that sale and its cost is charged to it. A filled sell re-buys the level its coins were bought on for the amount that slot held, which is the full per-level amount, or its share after partial fills. An empty buy level below the grid's centre price gets its buy back even when the price is already below it, and that buy fills at once. A rejected order counts as one rejection for its buy level or position. The bot looks it up for up to 5 seconds, books anything it traded, then sends the rest again with a new client order ID. An order it can't look up yet is checked again on later checks, and a minute later it is treated as rejected with nothing traded. The count carries over between checks but not across a restart. Other errors and accepted re-sends don't reset it. It starts again only once a later order of that level or position is seen on the book or filled. The third rejection sells everything and stops the bot (emergency stop). Rejections found during a sell-off are not counted, and trailing up starts every count again. Orders are cancelled through the local rate limiter, so shutdown can take time for large grids.

**Selling everything (stop-loss and emergency stop):** the bot first marks the sell-off in the saved state. It finishes any earlier sale and checks orders that were sent but never confirmed, then cancels every grid order and books anything that traded in the meantime. It then sells all held coins with market orders, in pieces no larger than the exchange maximum. A sale that fills nothing is retried, up to 3 times. A sale that fails to place leaves the sell-off pending. Coins behind an order whose cancel can't be confirmed are not sold. An order whose reply was lost, the split buy included, is looked up by its ID, and the coins it may hold are neither sold nor written off until it is found. While such an order, a grid order the exchange doesn't list yet, a cancel or sale that isn't confirmed, or an exchange error holds up the sale, the sell-off checks again every 30 seconds in the same run, for up to 6 minutes. An order missing for 5 minutes is treated as never placed and the sale goes on. An amount below the exchange minimum stays in the wallet and is booked as a loss. When everything is sold, the saved grid is deleted, so the next run starts fresh without `--reset`. If the sell-off can't finish, it stays pending, its message ends with the reason, and it is completed first on the next start, in the same live or dry-run mode. `--reset` drops it instead. Ctrl+C never sells. It stops the wait above, sends no new grid order and waits for a start-up already under way. Outside a sell-off, it then cancels the grid's orders, keeps the coins and ends the grid. A sale already sent during a sell-off finishes, no new one starts, and the rest of the sell-off finishes on the next start.

**Persistence:** State is saved periodically during the session. `Ctrl+C` ends the grid. It cancels every order, books what traded meanwhile and deletes the save. Any coins the grid bought and didn't sell stay in the wallet, and the next start begins a new grid. If a cancel isn't confirmed, an order isn't listed yet or the orders can't be checked, the save is kept, marked as stopped, and the next start checks those orders first. A stop signal (`kill`, `docker stop`, a system shutdown) cancels the orders and keeps the grid while it holds coins or an order isn't confirmed. After that or a crash, the next start resumes it. `--reset` starts a new grid even when the old one holds coins or has a pending sell-off. It first cancels the old grid's orders, one sent with a lost reply included, then deletes the save. The sell-off is dropped, and any coins the old grid bought and didn't sell stay in the wallet, outside the new grid. If a cancel isn't confirmed or the orders can't be listed, the save is kept, so run it again. An order the exchange doesn't list is named with its ID. A split buy or sale sent just before may still trade for a few minutes. If the saved grid file is damaged, the bot refuses to start, so the old grid's orders and coins are not left untracked. A new grid can't take them over, so first cancel the old grid's open orders in the Revolut X app and decide what to do with its coins. Then running with `--reset` renames the damaged file to `<name>.damaged-<time>` (it is never deleted) and starts a new grid. A file the bot isn't allowed to read is reported as a read error, not as damaged.

**One run per grid:** A grid run, live or dry, holds a lock file next to its saved state (`grid_state_<PAIR>.lock` in the config folder). A second run of the same pair from the same config folder, `--reset` included, is refused before it sends anything while the first one runs. A lock left on this machine by a run that crashed is taken over, also after a restart of the machine. Otherwise the error names the lock file to delete once no grid is running. Use one config folder per running machine or container. Two containers that share a host name and a config folder can each start the same grid, because neither sees the other's process.

**Outages and outside changes:** a key the exchange refuses (401 or 403) gets one Telegram message at once that names the masked key, and one more when it works again. The dashboard says how to fix it, and open grid orders stay on the exchange meanwhile. After a 401, fix the key with `revx configure` and start the grid again. After a 403, fix the key's permissions in Revolut X and the grid goes on by itself. After 5 minutes without prices or order data for any other reason, a grid sends one Telegram message, and one more when data is back. It keeps running meanwhile. A grid order cancelled outside the bot, for example in the app, is placed again, and the dashboard says how many and when. If one is replaced outside the bot, the grid places its own again. The dashboard, the restart summary and the stop message say the replacement is not tracked, so cancel it with `revx order cancel` if it isn't wanted.

**Reconciliation:** On startup, if a previous crash state exists, the bot reconciles automatically: fills are accounted for, orders matching the new grid are adopted, non-matching ones are cancelled, then a fresh grid is initialized. An order that was sent but never confirmed is looked up by its client order ID and sent again with the same ID if it isn't found. A saved order the exchange doesn't list yet stays tracked and is looked up again on later checks. Once it has been missing for 5 minutes it is sent again under its own client order ID, so the exchange can't place it twice. If that send fails, startup goes on with an alert and the bot retries it later. An order from an older save whose client order ID the bot can't find is not sent again. The bot sends a message, and only once it has been missing for 24 hours does it place a new order, with one more message. A split market buy whose reply was lost is looked up the same way before it is sent again. If the exchange has it but doesn't list it yet, startup stops and asks to start again in a few minutes. A send that fails while restoring the buys or split sells of an interrupted first placement doesn't stop startup.

---

### connector

Manage notification connectors. Currently supports Telegram.

```bash
revx connector telegram add --token <token> --chat-id <id>         # Add connection
revx connector telegram add --token <token> --chat-id <id> --test  # Test first, save only if it arrives
revx connector telegram list                                        # List connections
revx connector telegram test <id>                                   # Send test message
revx connector telegram enable <id>                                 # Enable connection
revx connector telegram disable <id>                                # Disable connection
revx connector telegram delete <id>                                 # Delete connection
```

Connectors receive alert notifications from `revx monitor` triggers.

---

## Output Formats

Commands default to formatted tables. Use `--json` for scripting or piping. `monitor` and `strategy grid run` show live output instead and take no `--json`.

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
