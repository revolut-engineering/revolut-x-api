---
name: revx-trading
description: >
  Revolut X order placement, replacement and cancellation. Use when the user asks to "place an order",
  "buy BTC", "sell ETH", "market order", "limit order", "replace order", "modify order",
  "cancel order", "cancel all orders", or runs revx order place, revx order replace or revx order cancel commands.
---

# Trading (`revx order place` / `revx order replace` / `revx order cancel`)

> Place market and limit orders, replace (modify) open orders, cancel open orders.

> **Auth required.** Make sure `revx` is installed and configured before running these commands. If any command fails with an auth-related error — `Auth not configured`, `No private key found`, `Authentication failed (401)`, `Invalid signature`, `insecure permissions`, or a missing key/config file at `~/.config/revolut-x/` — **invoke the `revx-auth` skill immediately and apply the fix yourself.** Do not interrupt the user to ask them to run setup. Only escalate to the user for steps only they can perform (pasting the API key, registering the public key in their Revolut X profile, choosing a passphrase). After the fix, retry the original command.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`. Check pair constraints with `revx market pairs` (see `revx-market` skill).

`order place` supports `--json` or `--output json` for machine-readable output.

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

# Combine — re-price and re-size
revx order replace <order-id> --price 96000 --qty 0.002
```

**Behavior:**
- Only fields you pass change; everything else stays as-is.
- If price changes on a `buy` and only one of qty/amount is provided, the amount stays and qty is recalculated. For `sell`, the opposite. If you change qty, amount is recalculated (and vice versa).
- `--allow-taker` must be set **explicitly** — it is never inferred.
- **The order ID changes.** After replace, the original order is closed and a new order is created with a new `venue_order_id` (returned in the response). The original ID is preserved on the new order as `previous_order_id`. Use the new ID for any further cancel/replace/get operations — the old ID will no longer be active.

**Flags:**

| Flag | Description |
|---|---|
| `--price <price>` | New limit price |
| `--qty <amount>` | New base-currency size |
| `--quote <amount>` | New quote-currency size |
| `--client-order-id <id>` | Client order ID for the replacement (auto-generated if omitted) |
| `--post-only` | Set execution to `[post_only]` |
| `--allow-taker` | Set execution to `[allow_taker]` explicitly |

At least one of `--price`, `--qty`, `--quote`, `--post-only`, `--allow-taker` is required.

---

## Cancel Orders

```bash
revx order cancel <order-id>           # Cancel a single order
revx order cancel --all                # Cancel all open orders
```

---

## Error Reference

| Error | Cause | Fix |
|---|---|---|
| Order rejected (400) | Invalid params or insufficient funds | Check pair constraints via `revx market pairs` |
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
