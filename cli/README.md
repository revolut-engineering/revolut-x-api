# revolutx-cli

Command-line interface for [Revolut X Exchange](https://revx.revolut.com). Trade crypto from your terminal.

## Installation

Download `revolutx-cli-*.tgz` from the [latest release](https://github.com/revolut-engineering/revolutx-ai/releases/latest), then:

```bash
npm install -g ./revolutx-cli-*.tgz
```

The CLI tarball includes the API client bundled inside — no extra dependencies to install.

Or from source:

```bash
# Build the API dependency first
cd api && npm install && npm run build && cd ..
# Then build and link the CLI
cd cli && npm install && npm run build && npm link
```

> **Troubleshooting:** If `revx` is not found after `npm link`, your shell may not
> have the npm global `bin` directory on `PATH`. Fix with one of:
>
> ```bash
> # Check where npm linked the binary
> npm bin -g
>
> # Option 1: asdf users — regenerate shims
> asdf reshim nodejs
>
> # Option 2: Add npm global bin to PATH (add to ~/.zshrc or ~/.bashrc)
> export PATH="$(npm bin -g):$PATH"
>
> # Option 3: Run directly without PATH
> npx revx --version
> ```

Requires Node.js 20+.

## Quick Start

```bash
revx configure                              # Setup API key + keypair
revx account balances                       # Check balances
revx market ticker BTC-USD                  # Get price
revx order place BTC-USD buy 0.001 --limit 95000  # Place limit buy
```

## Commands

### Configure

```bash
revx configure                     # Interactive setup (API key + keypair)
revx configure get                 # Show current config (redacted)
revx configure set --api-key KEY   # Set API key
revx configure generate-keypair    # Generate Ed25519 keypair
revx configure path                # Print config directory path
```

### Account

```bash
revx account balances              # List all balances
revx account balance BTC           # Single currency balance
```

### Market Data

```bash
revx market currencies             # List all currencies
revx market pairs                  # List all trading pairs
revx market tickers                # All tickers
revx market ticker BTC-USD         # Single pair ticker
revx market candles BTC-USD        # OHLCV candles (default 1h)
  --interval 60                    # Minutes: 5,15,30,60,240,1440,...
  --since 2025-01-01               # Start (ISO date or epoch ms)
  --until 2025-01-02               # End
revx market orderbook BTC-USD      # Order book snapshot
  --limit 10                       # Depth (1-20)
revx market trades                 # Public last trades (no auth)
revx market trades BTC-USD         # All trades for pair (authenticated)
  --start-date 2025-01-01
  --end-date 2025-01-02
  --limit 50
```

### Orders

```bash
revx order place BTC-USD buy 0.001 --limit 95000    # Limit buy
revx order place BTC-USD sell 0.001 --market         # Market sell
  --quote-size 100                                    # By quote amount
  --post-only                                         # Post-only
revx order list                     # Active orders
  --symbol BTC-USD                  # Filter by pair
  --side buy                        # Filter by side
revx order history                  # Historical orders
  --symbol BTC-USD
  --start-date 2025-01-01
  --end-date 2025-01-02
revx order get <order-id>           # Get specific order
revx order cancel <order-id>        # Cancel order
revx order fills <order-id>         # Get fills for order
```

### Trades

```bash
revx trade history BTC-USD          # My trade history
  --start-date 2025-01-01
  --end-date 2025-01-02
  --limit 50
```

### Alerts

Manage market price and technical indicator alerts.

```bash
revx alerts list                    # List all alerts
revx alerts get <alert-id>         # Show alert details
revx alerts enable <alert-id>     # Enable an alert
revx alerts disable <alert-id>    # Disable an alert
revx alerts delete <alert-id>     # Delete an alert
revx alerts types                  # List all alert types with config examples
```

Create alerts:

```bash
# Price alert
revx alerts create BTC-USD --type price --direction above --threshold 100000

# RSI alert
revx alerts create BTC-USD --type rsi \
  --config '{"period":14,"direction":"above","threshold":"70"}'

# EMA crossover
revx alerts create BTC-USD --type ema_cross \
  --config '{"fast_period":9,"slow_period":21,"direction":"bullish"}'

# MACD signal
revx alerts create BTC-USD --type macd \
  --config '{"fast":12,"slow":26,"signal":9,"direction":"bullish"}'

# Bollinger Bands
revx alerts create BTC-USD --type bollinger \
  --config '{"period":20,"std_mult":"2","band":"upper"}'

# Volume spike
revx alerts create BTC-USD --type volume_spike \
  --config '{"period":20,"multiplier":"2.0"}'

# Spread threshold
revx alerts create BTC-USD --type spread \
  --config '{"direction":"above","threshold":"0.5"}'

# Order book imbalance
revx alerts create BTC-USD --type obi \
  --config '{"direction":"above","threshold":"0.3"}'

# Price change %
revx alerts create BTC-USD --type price_change_pct \
  --config '{"lookback":24,"direction":"rise","threshold":"5.0"}'

# ATR breakout
revx alerts create BTC-USD --type atr_breakout \
  --config '{"period":14,"multiplier":"1.5"}'
```

Options for `alerts create`:
- `--type <type>` — Alert type (default: `price`). One of: `price`, `rsi`, `ema_cross`, `macd`, `bollinger`, `volume_spike`, `spread`, `obi`, `price_change_pct`, `atr_breakout`
- `--direction <dir>` — `above` or `below` (price alerts only, default: `above`)
- `--threshold <value>` — Price threshold (required for price alerts)
- `--config <json>` — JSON config object (required for non-price alerts)
- `--interval <sec>` — Poll interval in seconds, minimum 5 (default: `10`)

### Telegram

Manage Telegram bot connections for alert notifications.

```bash
revx telegram list                  # List all connections
revx telegram delete <conn-id>     # Delete a connection
revx telegram enable <conn-id>    # Enable a connection
revx telegram disable <conn-id>   # Disable a connection
revx telegram test <conn-id>      # Send a test message
  --message "Custom text"          # Optional custom message
```

Add a connection:

```bash
# Add with default label
revx telegram add --token "123456:ABC-DEF..." --chat-id "987654321"

# Add with custom label
revx telegram add --token "123456:ABC-DEF..." --chat-id "987654321" --label "main-alerts"

# Add and send test message
revx telegram add --token "123456:ABC-DEF..." --chat-id "987654321" --test
```

Options for `telegram add`:
- `--token <token>` — Telegram Bot API token (required)
- `--chat-id <id>` — Telegram chat ID (required)
- `--label <label>` — Connection label (default: `default`)
- `--test` — Send a test message after adding

## Output Formats

```bash
revx account balances                    # Default: table
revx account balances --json             # JSON output
revx account balances --output json      # Same as --json
revx account balances --output table     # Explicit table
```

Default output is formatted tables for terminals. Use `--json` for scripts and piping.

## Configuration

Credentials are stored in the platform config directory:

| Platform | Path |
|----------|------|
| macOS | `~/.config/revolut-x/` |
| Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |

Override with `REVOLUTX_CONFIG_DIR` environment variable.

Files:
- `config.json` — API key
- `private.pem` — Ed25519 private key
- `public.pem` — Ed25519 public key (register with Revolut X)

## Support

- **Issues:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)
- **Revolut X API Docs:** [developer.revolut.com/docs/crypto-exchange](https://developer.revolut.com/docs/crypto-exchange)

## License

MIT
