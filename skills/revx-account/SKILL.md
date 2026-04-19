---
name: revx-account
description: >
  Revolut X account and order queries. Use when the user asks to "check my balances",
  "view open orders", "order history", "order fills", "my trades", "trade history",
  or runs revx account, revx order open, revx order history, revx order get,
  revx order fills, revx trade commands.
---

# Account & Order Queries

> View balances, query orders, browse trade history.

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

## Open Orders

```bash
revx order open
revx order open --symbols BTC-USD,ETH-USD --side buy
revx order open --order-states pending_new,new --order-types limit --limit 50
```

**Filters:** `--symbols`, `--order-states` (pending_new, new, partially_filled), `--order-types` (limit, conditional, tpsl), `--side`, `--limit`

## Order History

```bash
revx order history
revx order history --symbols BTC-USD --start-date 7d --end-date today
revx order history --order-states filled,cancelled --limit 20
```

**Filters:** `--symbols`, `--order-states` (filled, cancelled, rejected, replaced), `--order-types` (market, limit), `--start-date`, `--end-date`, `--limit`

**Default:** When no dates are specified, returns the last 30 days. Time formats: relative (`7d`, `1w`, `today`), ISO date (`2025-04-14`), Unix epoch ms.

## Order Details & Fills

```bash
revx order get <order-id>              # Full order details
revx order fills <order-id>            # All fills for an order
```

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
