---
name: revx-monitor
description: >
  Revolut X live price and indicator monitoring. Use when the user asks to "monitor prices",
  "set up alerts", "watch RSI", "track EMA crossover", "volume spike alert",
  "Bollinger band alert", "MACD alert", or runs revx monitor commands.
  This is a long-running background process.
---

# Monitoring (`revx monitor`)

> Live price and technical indicator alerts. Runs as a continuous polling process.

> **Auth required.** Make sure `revx` is installed and configured before running these commands. If any command fails with an auth-related error — `Auth not configured`, `No private key found`, `Authentication failed (401)`, `Invalid signature`, `insecure permissions`, or a missing key/config file at `~/.config/revolut-x/` — **invoke the `revx-auth` skill immediately and apply the fix yourself.** Do not interrupt the user to ask them to run setup. Only escalate to the user for steps only they can perform (pasting the API key, registering the public key in their Revolut X profile, choosing a passphrase). After the fix, retry the original command.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`.

If Telegram connectors are configured (see `revx-telegram` skill), alerts are sent as notifications.

---

## Behavioral Instructions for Claude

### Long-Running Commands

All `revx monitor <type>` commands run **indefinitely** (polling loops with live dashboard output).

**How to handle:**

1. Run the command using the `Bash` tool with `run_in_background: true` — this frees Claude immediately while the process runs asynchronously
2. Periodically read the background task output file with the `Read` tool to monitor status and report key events to the user (alerts triggered, errors)
3. If the user asks to stop, use the `TaskStop` tool with the task ID
4. Also print the command to the user so they can optionally run it in a separate terminal for the full live dashboard experience (with colors, real-time tables, Ctrl+C to stop)

**Example — starting a monitor:**

Bash tool call:
```json
{ "command": "revx monitor price BTC-USD --direction above --threshold 100000", "run_in_background": true }
```

Response to user:

> Started monitoring BTC-USD price in the background. I'll check for alerts periodically.
>
> If you'd like to see the live dashboard, run this in a separate terminal:
> ```bash
> revx monitor price BTC-USD --direction above --threshold 100000
> ```
> Press Ctrl+C to stop. Alerts will also be sent to Telegram if configured.

---

## All Monitor Types

```bash
# Price threshold
revx monitor price BTC-USD --direction above --threshold 100000

# RSI (Relative Strength Index)
revx monitor rsi ETH-USD --direction above --threshold 70 --period 14

# EMA crossover
revx monitor ema-cross BTC-USD --direction bullish --fast-period 9 --slow-period 21

# MACD crossover
revx monitor macd BTC-USD --direction bullish --fast 12 --slow 26 --signal 9

# Bollinger Bands breach
revx monitor bollinger BTC-USD --band upper --period 20 --std-mult 2

# Volume spike
revx monitor volume-spike BTC-USD --period 20 --multiplier 2.0

# Bid-ask spread
revx monitor spread BTC-USD --direction above --threshold 0.5

# Order book imbalance
revx monitor obi BTC-USD --direction above --threshold 0.3

# Price change percentage
revx monitor price-change BTC-USD --direction rise --threshold 5.0 --lookback 24

# ATR breakout
revx monitor atr-breakout BTC-USD --period 14 --multiplier 1.5

# List all types with descriptions
revx monitor types
```

**Common option:** `--interval <seconds>` (whole seconds from 5 to 86400, default 10). A value outside that range is refused, not adjusted.

**When an alert fires:** threshold monitors (price, RSI, Bollinger, spread, OBI and the others) alert as soon as the condition holds, also at start. `ema-cross` and `macd` only arm on the first check and alert on a fresh crossover, so a trend already in place at start sends nothing. A crossover alerts at most once per hourly candle, so a cross that flips back and forth within the hour sends one message. While a condition holds, later checks show a short "still met" line instead of a new alert, and a crossover that forms again within the hour shows "alerted this hour". "Notified" is shown only when at least one Telegram message was delivered, otherwise the line says the notification failed. If Revolut X refuses the API key (401 or 403), the monitor sends one message at once that names the masked key and how to fix it, keeps checking, and sends one more when the key works again. After a 401, fix the key with `revx configure` and start the monitor again. After a 403, fix the key's permissions in Revolut X and the monitor goes on by itself. After 5 minutes without data for any other reason it sends one message, and one more when data is back, saying how long it lasted.

**Input checks:** every option is checked before the monitor starts, and a bad value stops it with the option's name. Numbers are decimals such as `100000` or `0.0000001`, also in exponent form such as `1e-7`, not `100k` or `100,000`. They must be below 1e15 with at most 18 decimal places. Periods are whole numbers up to 99, since a monitor reads the last 100 hourly candles. RSI, Bollinger and the MACD `--signal` need at least 2, and `--slow` plus `--signal` can be at most 100. A fast period must be below its slow period. Price and price-change thresholds are above 0, spread thresholds at least 0, RSI thresholds above 0 and below 100, OBI thresholds from -1 to 1, and multipliers above 0. The pair must be one Revolut X trades right now. A monitor that has too few candles for its period says so on every check.

## Monitor Defaults

| Type | Key Defaults |
|---|---|
| `price` | direction: above, threshold: **required** |
| `rsi` | direction: above, threshold: 70, period: 14 |
| `ema-cross` | direction: bullish, fast: 9, slow: 21 |
| `macd` | direction: bullish, fast: 12, slow: 26, signal: 9 |
| `bollinger` | band: upper, period: 20, std-mult: 2 |
| `volume-spike` | period: 20, multiplier: 2.0 |
| `spread` | direction: above, threshold: 0.5 |
| `obi` | direction: above, threshold: 0.3 |
| `price-change` | direction: rise, threshold: 5.0, lookback: 24 |
| `atr-breakout` | period: 14, multiplier: 1.5 |

---

## Common Workflow: Set Up Price Alert with Telegram

```bash
revx connector telegram add --token <token> --chat-id <id> --test
revx monitor price BTC-USD --direction above --threshold 100000
```

> **See also:** `revx-telegram` skill for full Telegram connector management.

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-telegram` | Configure Telegram notifications for alerts |
| `revx-market` | Understand market data and indicators |
| `revx-strategy` | Automated grid trading with monitoring |
| `revx-account` | Check balances and order status |
| `revx-auth` | API key setup and configuration |
