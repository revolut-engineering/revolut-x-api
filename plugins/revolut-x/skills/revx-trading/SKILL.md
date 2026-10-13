---
name: revx-trading
description: >
  Revolut X order placement, replacement and cancellation. Use when the user asks to "place an order",
  "buy BTC", "sell ETH", "market order", "limit order", "replace order", "modify order",
  "cancel order", "cancel all orders", or runs revx order place, revx order replace or revx order cancel commands.
---

# Trading (`revx order place` / `revx order replace` / `revx order cancel`)

> Place market and limit orders, replace (modify) open orders, cancel open orders.

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

Only execute after the user explicitly approves (e.g., "yes", "go ahead", "do it").

For `revx order cancel --all`, warn the user that this cancels **every** open order and confirm.

### Missing Parameters — Always Ask, Never Guess

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
| `--market` | Market order (required unless `--limit`) |
| `--limit <price>` | Limit price (required unless `--market`) |
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

## Replace (Modify) Orders

Updates an existing open order in place. Same URL as cancel, but with `PUT`.

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
```

**Behavior:**
- Only fields you pass change; everything else stays as-is.
- Changing only `--price` keeps a `buy`'s quote amount (its quantity changes) and a `sell`'s quantity. To keep a buy's quantity, pass `--qty <current qty>` too. If you change qty, amount is recalculated (and vice versa).
- `--allow-taker` must be set **explicitly** — it is never inferred.
- **A rejected replacement leaves no order.** The exchange cancels the original first, so when the replacement comes back `rejected`, or a replacement without `--time-in-force ioc` comes back `cancelled`, neither order is open and the command exits 1.
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

At least one of `--price`, `--qty`, `--quote`, `--time-in-force`, `--post-only`, `--allow-taker` is required.

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
revx order cancel <order-id>           # Cancel a single order
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
