---
name: revx-trading
description: >
  Revolut X order placement, replacement and cancellation. Use when the user asks to "place an order",
  "buy BTC", "sell ETH", "market order", "limit order", "conditional order", "stop order", "stop-limit order",
  "take profit", "stop loss", "trigger order", "replace order", "modify order",
  "cancel order", "cancel all orders", or runs revx order place, revx order replace or revx order cancel commands.
---

# Trading (`revx order place` / `revx order replace` / `revx order cancel`)

> Place market, limit, conditional (stop) and take-profit/stop-loss orders, replace (modify) open orders, cancel open orders.

> **Auth required.** Make sure `revx` is installed and configured before running these commands. If any command fails with an auth-related error — `Auth not configured`, `No private key found`, `Authentication failed (401)`, `Invalid signature`, `insecure permissions`, or a missing key/config file at `~/.config/revolut-x/` — **invoke the `revx-auth` skill immediately and apply the fix yourself.** Do not interrupt the user to ask them to run setup. Only escalate to the user for steps only they can perform (pasting the API key, registering the public key in their Revolut X profile). After the fix, retry the original command.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`. Check pair constraints with `revx market pairs` (see `revx-market` skill).

`order place` and `order replace` support `--json` or `--output json` for machine-readable output.

---

## Behavioral Instructions for Claude

### Human Confirmation Required

**NEVER execute `revx order place`, `revx order replace`, or `revx order cancel` without explicit user confirmation.** These commands move real money.

Before running any order command, present a confirmation summary to the user:

> **Order to place:**
> - Pair: BTC-USD
> - Side: buy
> - Type: limit @ $95,000
> - Size: 0.001 BTC
>
> Shall I proceed?

For conditional and take-profit/stop-loss orders, include the trigger details in the summary:

> **Order to place:**
> - Pair: BTC-USD
> - Side: sell
> - Type: conditional — triggers at $100,000, then sells 0.001 BTC at market
>
> Shall I proceed?

Only execute after the user explicitly approves (e.g., "yes", "go ahead", "do it").

For `revx order cancel --all`, warn the user that this cancels **every** open order and confirm.

### Missing Parameters — Always Ask, Never Guess

All required parameters must come from the user. If any are missing, ask for them before building the command.

**Required for every order:**
1. **Symbol** — which pair? (e.g., `BTC-USD`)
2. **Side** — buy or sell?
3. **Size** — how much? (`--qty` for base currency or `--quote` for quote currency; take-profit/stop-loss orders accept `--qty` only)
4. **Order type** — market (`--market`), limit (`--limit <price>`), conditional (`--conditional`), or take-profit/stop-loss (`--tp`/`--sl`)?

**Additional requirements by order type:**
- **Conditional orders** also need a **trigger price**. Optionally a trigger limit price.
- **Take-profit/stop-loss orders** need at least one of `--tp <price>` / `--sl <price>`. Trigger directions are derived from the side automatically — never pass them.

**Never assume defaults for these parameters.** If the user says "buy some BTC", ask:
- How much? (quantity in BTC or dollar amount)
- Market order or limit? (if limit, at what price?)

Optional flags (`--post-only`) can be omitted unless the user requests them.

---

## Place Orders

```bash
# Market order (buy 0.001 BTC at best price)
revx order place BTC-USD buy --qty 0.001 --market

# Limit order (buy 0.001 BTC at $95,000 or better)
revx order place BTC-USD buy --qty 0.001 --limit 95000

# Post-only limit (maker only, cancelled if would take)
revx order place BTC-USD buy --qty 0.001 --limit 95000 --post-only

# Limit order with time in force (immediate-or-cancel)
revx order place BTC-USD buy --qty 0.001 --limit 95000 --time-in-force ioc

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
| `--market` | Market order (required unless another order type is chosen) |
| `--limit <price>` | Limit price (required unless another order type is chosen) |
| `--time-in-force <value>` | `gtc` (default) or `ioc`. Limit orders only — `fok` is not accepted when placing. |
| `--post-only` | Post-only execution (limit orders only) |
| `--client-order-id <uuid>` | Your own ID for the order, so a retry can't place it twice (generated if omitted) |

Must specify either `--qty` or `--quote` (not both).

**Reading the result:** the exchange answers with the order's state, and the exit code follows it. With `--json`, an answered order prints the exchange's document with the same exit code and the reason for a failure on stderr. A request the exchange refuses outright prints only its error on stderr. A new order isn't listed for a few seconds, so wait before `revx order get` or `revx order fills`.

| State | Meaning | Exit code |
|---|---|---|
| `pending_new`, `new`, `partially_filled`, `filled` | Placed | 0 |
| `cancelled`, market or IOC order | Closed at once. See what filled with `revx order fills <id>` | 0 |
| `cancelled`, any other order | The exchange cancelled it at once. It may have partly filled, so check `revx order get <id>` before placing it again | 1 |
| `rejected` | Not placed. With `--post-only`, usually because the price would have traded at once | 1 |
| Any other state | Sent. Check it with `revx order get <id>` | 0 |

**If the reply is lost:** every order is sent with a client order ID, generated unless you pass `--client-order-id`. When the connection drops after the order may have reached the exchange, or the exchange answers with a server error, the command exits 1, says the order may have been placed and prints its client order ID on stderr. stdout stays empty, also with `--json`, so a script should pass its own `--client-order-id` (a UUID). Look for that ID in `revx order open --json`, or `revx order history --json` once it has filled, before doing anything else. A market order can take a few minutes to show up. To retry, run the same command with `--client-order-id <that ID>`: if the first one went through, the exchange refuses the retry as already placed, and the CLI then says an order with that ID already exists and no second one was placed. Never retry without the ID, or a second order can be placed. A connection that fails before sending, such as a refused connection or a DNS failure, says so and placed nothing. For a replace, `revx order get <original id>` tells whether it happened: an original still open means the replace did not happen.

**Price step:** a `--limit` or `--price` must be a multiple of the pair's price step (`revx market pairs` shows it). Otherwise the CLI refuses it before sending and names the nearest valid prices. `--qty`, `--quote`, `--limit` and `--price` must be positive numbers with at most 18 decimal places.

---

## Conditional (Stop) Orders

Waits until the market price crosses the trigger, then places a market order (default) or a limit order (with `--trigger-limit-price`). Exactly one order type per command.

```bash
# Stop-market: sell 0.001 BTC when the $100,000 trigger fires
revx order place BTC-USD sell --qty 0.001 --conditional --trigger-price 100000

# Stop-limit: buy 0.001 BTC when the $90,000 trigger fires, then place a limit buy at $89,900
revx order place BTC-USD buy --qty 0.001 --conditional --trigger-price 90000 --trigger-limit-price 89900

# Quote-sized conditional (buy $500 worth of BTC at the $95,000 trigger)
revx order place BTC-USD buy --quote 500 --conditional --trigger-price 95000
```

**Flags:**

| Flag | Description |
|---|---|
| `--conditional` | Conditional (stop) order type |
| `--trigger-price <price>` | Price that activates the order (required) |
| `--trigger-limit-price <price>` | Limit price for the order placed on trigger; market execution when omitted |
| `--qty <amount>` / `--quote <amount>` | Size — exactly one required |

**Behavior:**
- `--time-in-force` and `--post-only` are limit-order flags — they are rejected with conditional orders.
- Once triggered, a market leg executes immediately (ioc); a limit leg rests as a gtc limit order.
- The order rests in `revx order open` with type `conditional` and a `Trig ≥/≤ <price>` condition until it triggers or is cancelled.
- Cancel with the usual `revx order cancel <order-id>`.

---

## Take-Profit / Stop-Loss Orders

Places a resting order that exits a position when the market reaches the take-profit and/or stop-loss trigger. At least one of `--tp`/`--sl` is required; both can be combined. Trigger directions are **derived from the side** — do not pass them:

- **Sell** TP/SL (closing a long): take profit fires when price **rises to/above** `--tp`; stop loss fires when price **falls to/below** `--sl`.
- **Buy** TP/SL (closing a short): take profit fires when price **falls to/below** `--tp`; stop loss fires when price **rises to/above** `--sl`.

```bash
# Sell 0.001 BTC: take profit at $110,000, stop loss at $90,000 (both market on trigger)
revx order place BTC-USD sell --qty 0.001 --tp 110000 --sl 90000

# Take profit only, with a limit price for the triggered leg
revx order place BTC-USD sell --qty 0.001 --tp 110000 --tp-limit 109900

# Stop loss only
revx order place BTC-USD sell --qty 0.001 --sl 90000

# Both legs with limit prices
revx order place BTC-USD sell --qty 0.001 --tp 110000 --tp-limit 109900 --sl 90000 --sl-limit 89900
```

**Flags:**

| Flag | Description |
|---|---|
| `--tp <price>` | Take-profit trigger price (at least one of `--tp`/`--sl` required) |
| `--sl <price>` | Stop-loss trigger price |
| `--tp-limit <price>` | Limit price for the take-profit leg (market on trigger when omitted) |
| `--sl-limit <price>` | Limit price for the stop-loss leg (market on trigger when omitted) |
| `--qty <amount>` | Size in base currency — **required**; `--quote` is not accepted for TP/SL orders |

**Behavior:**
- `--time-in-force` and `--post-only` are rejected with TP/SL orders.
- The order appears in `revx order open` with type `tpsl`; the Conditions column shows `TP <price>` / `SL <price>`.
- If both legs are set, the first trigger wins and the other is discarded.
- Cancel with the usual `revx order cancel <order-id>`.

---

## Replace (Modify) Orders

Updates an existing open order in place. Same URL as cancel, but with `PUT`. Works for limit, conditional (stop), and take-profit/stop-loss orders.

```bash
# Change limit price
revx order replace <order-id> --price 96000

# Change quantity (amount is recalculated server-side)
revx order replace <order-id> --qty 0.002

# Change quote amount (qty is recalculated server-side)
revx order replace <order-id> --quote 150

# Explicitly allow taker execution (must be set explicitly)
revx order replace <order-id> --allow-taker

# Switch to post-only
revx order replace <order-id> --post-only

# Change time in force
revx order replace <order-id> --time-in-force ioc

# Combine — re-price and re-size
revx order replace <order-id> --price 96000 --qty 0.002

# Replace a conditional (stop) trigger — the whole trigger is replaced
revx order replace <order-id> --trigger-price 100000 --trigger-limit-price 99500

# Change only the trigger limit price → re-pass the whole trigger
revx order replace <order-id> --trigger-price 100000 --trigger-limit-price 99000

# Replace take-profit/stop-loss triggers, or re-size the order only
revx order replace <order-id> --tp 115000 --tp-limit 114900 --sl 90000
revx order replace <order-id> --qty 0.002

# Remove a trigger leg — pass `none` explicitly
revx order replace <order-id> --sl none
```

**Behavior:**
- Only fields you pass change; everything else stays as-is.
- Changing only `--price` keeps a `buy`'s quote amount (its quantity changes) and a `sell`'s quantity. To keep a buy's quantity, pass `--qty <current qty>` too. If you change qty, amount is recalculated (and vice versa).
- `--allow-taker` must be set **explicitly** — it is never inferred.
- **A rejected replacement leaves no order.** The exchange cancels the original first, so when the replacement comes back `rejected`, or a replacement without `--time-in-force ioc` comes back `cancelled`, neither order is open and the command exits 1.
- **Triggers are replaced as a whole.** To change a single field inside a trigger (e.g. only the limit price), pass the entire trigger again. Omitting the limit price switches that leg to market execution on trigger.
- **To remove a trigger, pass `none` explicitly** — `--tp none`, `--sl none`, or `--trigger-price none`. Omitting the flag keeps the trigger unchanged.
- `--price`/`--time-in-force`/`--post-only`/`--allow-taker` apply to limit orders, `--trigger-price` to conditional orders, `--tp`/`--sl` to take-profit/stop-loss orders — these groups cannot be mixed.
- **The order ID changes.** After replace, the original order is closed and a new order is created with a new `venue_order_id` (returned in the response). The original ID is preserved on the new order as `previous_order_id`. Use the new ID for any further cancel/replace/get operations — the old ID will no longer be active.

**Flags:**

| Flag | Description |
|---|---|
| `--price <price>` | New limit price |
| `--qty <amount>` | New base-currency size |
| `--quote <amount>` | New quote-currency size |
| `--client-order-id <uuid>` | Your own UUID for the replacement (generated if omitted) |
| `--time-in-force <value>` | `gtc` or `ioc`. `fok` is not accepted when replacing. |
| `--post-only` | Set execution to `[post_only]` |
| `--allow-taker` | Set execution to `[allow_taker]` explicitly |
| `--trigger-price <price>` | New conditional trigger price (`none` removes the trigger) |
| `--trigger-limit-price <price>` | Limit price for the conditional trigger (only with `--trigger-price`) |
| `--tp <price>` | New take-profit trigger price (`none` removes the leg) |
| `--tp-limit <price>` | Limit price for the take-profit trigger (only with `--tp`) |
| `--sl <price>` | New stop-loss trigger price (`none` removes the leg) |
| `--sl-limit <price>` | Limit price for the stop-loss trigger (only with `--sl`) |

At least one of `--price`, `--qty`, `--quote`, `--time-in-force`, `--post-only`, `--allow-taker`, `--trigger-price`, `--tp`, `--sl` is required.

---

## Fees

Revolut X takes the fee from what you receive, so the side of the order decides the currency:

| Order | You pay | You receive | Fee is taken in | Effect |
|---|---|---|---|---|
| Buy | quote (e.g. USD) | base (e.g. BTC) | base | You pay for the quantity bought (all of it for an order sized in quote) and slightly fewer coins arrive. |
| Sell | base | quote | quote | All the coins leave and slightly less quote arrives. |

- **Rates:** maker 0% for an order that rests on the book, taker 0.09% for an order that trades at once (market orders and limit orders priced through the market). Fees are rounded up to the currency's smallest unit.
- **Real example, buy (7 Oct 2026):** a 10 USDC market buy of BTC filled 0.00011904 BTC. The fee was 0.00000011 BTC, so 0.00011893 BTC arrived and the full 10 USDC was spent.
- **Real example, sell:** a BTC sale worth 9.957938 USDC paid a fee of 0.008963 USDC, so 9.948975 USDC arrived.
- **Where to see it:** each filled order reports `total_fee` and `fee_currency` (`revx order get <id> --json`). Use those rather than estimating, because rates can change.

## Cancel Orders

```bash
revx order cancel <order-id>           # Cancel a single order (market, limit, conditional, tpsl)
revx order cancel --all                # Cancel all open orders
revx order cancel <order-id> --json    # {"cancelled": "<order-id>"}, or {"cancelled": "all"} with --all
```

---

## Error Reference

| Error | Cause | Fix |
|---|---|---|
| Invalid order parameters, or Invalid replace order parameters | The CLI's own check found a bad value before sending, the lines below name each field | Fix the named field, for example the symbol format `BTC-USD` |
| Bad request (400) with the exchange's message | The exchange refused the order, for example a size outside the pair's limits | Check sizes and steps with `revx market pairs` |
| Not a multiple of the price step | `--limit` or `--price` is finer than the pair's price step | Use one of the two prices the message suggests |
| Insufficient balance (422) | Not enough funds for the order | Check `revx account balances` |
| State `rejected` or `cancelled`, exit 1 | The exchange refused or closed the order | `revx order get <id>` after a few seconds |
| Not found (404) | Invalid order ID | Verify with `revx order open` (see `revx-account` skill) |
| Rate limit (429) | Too many requests | Wait for `retryAfter` duration |

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-account` | Check balances, view order status and fills after trading |
| `revx-market` | Check prices and pair constraints before trading |
| `revx-auth` | API key setup and passkey configuration |
| `revx-strategy` | Automated grid trading bot |
