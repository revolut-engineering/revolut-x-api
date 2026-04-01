---
name: revx-trading
description: >
  Revolut X order placement and cancellation. Use when the user asks to "place an order",
  "buy BTC", "sell ETH", "market order", "limit order", "cancel order", "cancel all orders",
  or runs revx order place or revx order cancel commands.
---

# Trading (`revx order place` / `revx order cancel`)

> Place market and limit orders, cancel open orders.

Ensure `revx` is installed and configured — see `revx-auth` skill.

**Passkey required** for all order placement and cancellation — see `revx-auth` skill to set one up.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`. Check pair constraints with `revx market pairs` (see `revx-market` skill).

`order place` supports `--json` or `--output json` for machine-readable output.

---

## Behavioral Instructions for Claude

### Human Confirmation Required

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
