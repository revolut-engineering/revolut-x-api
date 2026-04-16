---
name: revx-market
description: >
  Revolut X market data commands. Use when the user asks to "check crypto prices",
  "view candles", "get ticker", "see order book", "list currencies", "list trading pairs",
  or runs revx market commands.
---

# Market Data (`revx market`)

> Query currencies, trading pairs, live prices, historical candles, and order book depth.

Ensure `revx` is installed, up to date (`npm update -g cli-k9x2a`), and configured — see `revx-auth` skill.

All commands support `--json` or `--output json` for machine-readable output.

Symbols use `BASE-QUOTE` format with a dash: `BTC-USD`, `ETH-EUR`, `SOL-USD`. Use `revx market pairs` to see all valid pairs.

---

## Currencies & Pairs

```bash
revx market currencies                 # All currencies (symbol, name, type, scale, status)
revx market currencies fiat            # Fiat currencies only
revx market currencies crypto          # Crypto currencies only
revx market currencies --filter BTC,ETH  # Filter by specific symbols
revx market pairs                      # All pairs (base, quote, min/max size, status)
revx market pairs --filter BTC-USD,ETH-USD  # Filter by specific pairs
```

---

## Tickers

```bash
revx market tickers                    # All tickers (bid, ask, mid, last)
revx market tickers --symbols BTC-USD,ETH-USD
revx market tickers BTC-USD            # Single ticker (key-value display)
```

---

## Candles

```bash
revx market candles BTC-USD                              # Default: 1h interval
revx market candles BTC-USD --interval 5m                # 5-minute candles
revx market candles BTC-USD --since 7d --until today     # Last 7 days
revx market candles BTC-USD --since 2025-04-14           # Since specific ISO date
revx market candles BTC-USD --since 5m --interval 1m     # Last 5 minutes, 1m candles
revx market candles ETH-USD --interval 4h --since 30d
```

**Intervals:** `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `2d`, `4d`, `1w`, `2w`, `4w` (or raw minutes)

**Time formats:** Relative (`7d`, `1w`, `4h`, `30m`, `5m`, `today`, `yesterday`), ISO date (`2025-04-14`), Unix epoch ms

**Default behavior:** When `--since` and `--until` are omitted, fetches the maximum available history for the given interval (up to 50,000 candles).

---

## Order Book

```bash
revx market orderbook BTC-USD          # Top 10 levels (default)
revx market orderbook BTC-USD --limit 20
```

Depth: 1–20 levels.

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-trading` | Act on market data — place orders |
| `revx-monitor` | Set alerts based on prices and indicators |
| `revx-account` | Check balances before trading |
| `revx-auth` | API key setup and configuration |
