# Revolut X — OpenClaw / clawhub bundle

Revolut X is a low-fees crypto exchange by Revolut. Skills for crypto trading, market data, monitoring, and grid bot strategies on the Revolut X exchange.

## Install

```bash
openclaw plugins install clawhub:revolut-x
```

## Skills

| Skill | Trigger |
|---|---|
| `revx-auth` | install, configure API keys, generate keypair, set passkey |
| `revx-market` | check prices, view candles, ticker, order book, list pairs |
| `revx-account` | balances, open orders, order history, fills, trade history |
| `revx-trading` | place / cancel market and limit orders |
| `revx-monitor` | live price + indicator alerts (RSI, EMA, MACD, Bollinger, OBI, ATR, …) |
| `revx-telegram` | set up a Telegram connector for alerts |
| `revx-strategy` | grid trading: backtest, optimize parameters, run a grid bot |

## Prerequisites

The skills assume the `revx` CLI is installed and configured with your Revolut X API keys. See the [main repository README](https://github.com/revolut-engineering/revolut-x-api) for installation; the `revx-auth` skill walks the assistant through configuration if it isn't already set up.

## Source

[github.com/revolut-engineering/revolut-x-api](https://github.com/revolut-engineering/revolut-x-api) · MIT
