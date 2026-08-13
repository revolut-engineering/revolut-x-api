---
name: revx-account
description: >
  Revolut X account, transaction, order, and trade queries. Use when the user asks to
  "check my balances", "transaction history", "deposits", "withdrawals", "buys", "sells",
  "sends", "receives", "view open orders", "order history", "TWAP order", "order fills",
  "my trades", "trade history", or runs revx account, revx transaction, revx order open,
  revx order history, revx order get, revx order fills, or revx trade commands.
---

# Account, Transaction & Order Queries

> View balances and transactions, query orders, browse trade history.

> **Auth required.** Make sure `revx` is installed and configured before running these commands. If any command fails with an auth-related error — `Auth not configured`, `No private key found`, `Authentication failed (401)`, `Invalid signature`, `insecure permissions`, or a missing key/config file at `~/.config/revolut-x/` — **invoke the `revx-auth` skill immediately and apply the fix yourself.** Do not interrupt the user to ask them to run setup. Only escalate to the user for steps only they can perform (pasting the API key, registering the public key in their Revolut X profile, choosing a passphrase). After the fix, retry the original command.

All commands support `--json` or `--output json` for machine-readable output.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`.

---

## Balances

```bash
revx account balances                          # Non-zero balances
revx account balances --all                    # Include zero balances
revx account balances BTC                      # Single currency (case-insensitive)
revx account balances --currencies BTC,ETH,USD # Filter by multiple currencies
```

---

## Transactions

```bash
revx transaction list                              # Last 30 days
revx transaction list --start-date 7d              # Last 7 days
revx transaction list --types buy,receive          # Types: buy, sell, send, receive
revx transaction list --statuses completed,pending # Filter by status
revx transaction list --currencies BTC,USD         # Filter by either side
revx transaction list --limit 100 --json            # Limit and JSON output
```

**Filters:** `--start-date`, `--end-date`, `--types` (buy, sell, send, receive), `--statuses` (pending, completed, rejected, failed, cancelled), `--currencies`, `--limit`

**Default:** When no dates are specified, returns the last 30 days. Time formats: relative (`7d`, `1w`, `today`), ISO date (`2025-04-14`), Unix epoch ms.

In table output, show the complete transaction UUID. The source side is `Source Amount` with a minus sign and the destination side is `Destination Amount` with a plus sign. A transaction may contain both sides, only `Source Amount`, or only `Destination Amount`. Do not expect account fields in transaction-list results.

In JSON output, use `source_currency` with `source_amount` for billing and `destination_currency` with `destination_amount` for received funds. Each currency/amount pair is optional as a pair; at least one side is present. Processing time is `processed_date`.

---

## Open Orders

```bash
revx order open
revx order open --symbols BTC-USD,ETH-USD --side buy
revx order open --order-states pending_new,new --order-types limit --limit 50
revx order open --order-types twap
```

**Filters:** `--symbols`, `--order-states` (pending_new, new, partially_filled), `--order-types` (limit, conditional, tpsl, twap), `--side`, `--limit`

TWAP rows show their execution type (market or limit), optional limit price, period/frequency, and completed/total slice progress.

## Order History

```bash
revx order history
revx order history --symbols BTC-USD --start-date 7d --end-date today
revx order history --order-states filled,cancelled --limit 20
revx order history --order-types twap --start-date 7d
```

**Filters:** `--symbols`, `--order-states` (filled, cancelled, rejected, replaced, partially_filled), `--order-types` (market, limit, conditional, tpsl, twap), `--start-date`, `--end-date`, `--limit`

**Default:** When no dates are specified, returns the last 30 days. Time formats: relative (`7d`, `1w`, `today`), ISO date (`2025-04-14`), Unix epoch ms.

## Order Details & Fills

```bash
revx order get <order-id>              # Full order details
revx order fills <order-id>            # All fills for an order
```

Order details always include `time_in_force` — one of `gtc`, `ioc`, or `fok` (an order can come back as `fok` even though only `gtc`/`ioc` can be set when placing/replacing).

Optional fields in order details output (shown only when present):
- `amount` / `filled_amount` — quote-currency size and how much of it has been filled
- `average_fill_price` — volume-weighted average execution price (shown as "Avg Fill Price"); only present for filled or partially filled orders
- `total_fee` / `fee_currency` — total fee charged and the currency it was paid in
- `conditional` / `take_profit` / `stop_loss` — trigger definitions on conditional and TPSL orders; each includes trigger price, direction (≥/≤), order type (market/limit), time in force, and optional limit price
- `twap` — schedule and progress for a TWAP parent order: child execution type (`market` or `limit`), optional limit `price`, `period` and `frequency` in seconds, total/completed slices, start/end times, and (for `order get`) any linked child order IDs
- `triggered_by` — present when this order was submitted by a conditional, TP/SL, or TWAP trigger; `reason: twap` includes the TWAP parent order ID and slice index. Mutually exclusive with `on_fill`.
- `on_fill` — present when a linked TP/SL exit strategy is attached to this order; includes take-profit / stop-loss triggers and, once the order is filled, the linked order `id`. Mutually exclusive with `triggered_by`.

For a full TWAP execution tree, run `revx order get <twap-parent-id>` and then inspect each linked child ID with `revx order get <child-id>`. Linked child IDs are available on the parent detail response, not in open-order or history lists.

---

## Trades

```bash
revx trade private BTC-USD                                # My trade history
revx trade private BTC-USD --start-date 7d --limit 100
revx trade private BTC-USD --start-date 2025-04-01 --end-date 2025-04-14
revx trade public BTC-USD                                 # Public trades
revx trade public BTC-USD --start-date 7d --end-date today
```

**Filters:** `--start-date`, `--end-date`, `--limit`

**Default:** When no dates are specified, returns the last 30 days. Time formats: relative (`7d`, `1w`, `today`), ISO date (`2025-04-14`), Unix epoch ms.

Aliases: `revx trade history` = `private`, `revx trade all` = `public`.

---

## Permission Handling for Recurring Commands (/loop)

When using `/loop` to run `revx` commands on an interval, each iteration triggers a permission prompt. To avoid repeated approvals:

1. Determine the exact `revx` commands needed for each iteration (e.g., `revx account balances`, `revx order open`)
2. Run each command as a **separate `Bash` tool call** — do NOT chain with `&&` or pipes. This ensures each command matches a simple permission pattern
3. Present the specific commands to the user and ask for permission to add them to the allowlist
4. Use the `update-config` skill to add **specific** permission patterns to `.claude/settings.local.json`, e.g.:
   ```json
   "Bash(revx account balances*)",
   "Bash(revx order open*)"
   ```
   Do NOT add a blanket `Bash(revx *)` — only add the exact commands the loop needs
5. Then start the `/loop`

**Permission pattern syntax:** `Bash(revx account balances*)` uses a glob wildcard — the trailing `*` allows optional flags. The pattern uses a **space** separator (not colon). Compound commands with `&&` or `|` are split into subcommands, each checked independently.

**Example flow** for "every 10 min check my balance and open orders":

1. Determine needs: `revx account balances` and `revx order open`
2. Tell the user: "I'll run these two commands each iteration — can I add them to your permission allowlist?"
3. On approval, add `Bash(revx account balances*)` and `Bash(revx order open*)` via `update-config`
4. Start `/loop 10m check balance and open orders`
5. Each iteration runs two separate `Bash` calls — no further prompts

---

## Common Workflows

### "What's my BTC worth?"
```bash
revx account balances BTC
revx market tickers BTC-USD
```

### "Review recent trading activity"
```bash
revx transaction list --start-date 7d
revx order history --start-date 7d
revx trade private BTC-USD --start-date 7d
```

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-trading` | Place and cancel orders |
| `revx-market` | Check prices and pair constraints |
| `revx-monitor` | Set alerts on prices and indicators |
| `revx-auth` | API key setup and configuration |
