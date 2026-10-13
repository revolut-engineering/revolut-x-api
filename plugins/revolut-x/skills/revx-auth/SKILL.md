---
name: revx-auth
description: >
  Revolut X CLI setup and authentication. Use when the user asks to "install revx",
  "set up Revolut X", "configure API keys", "generate keypair", "set passkey",
  "revx configure", or needs help with authentication errors.
---

# Auth & Account Setup (`revx configure`)

> Install the CLI, generate API keys, and configure write-operation security.

> **Auto-resolve target.** When invoked from another `revx-*` skill due to an auth error, do not bounce the user back to manual setup. Diagnose the failure against the [Error Reference](#error-reference) below, run the fix yourself (e.g. `chmod 600 ~/.config/revolut-x/private.pem`, `revx configure generate-keypair`, `revx configure set --api-key <key>`), then return to the calling skill and retry the original command. Only ask the user for inputs that only they can provide: the 64-character API key string, confirmation that they have registered the public key in their Revolut X profile, or approval to move an existing keypair aside.

## Prerequisites

- **Node.js >= 20** (check with `node -v`)
- **npm** (comes with Node.js)

## Install

```bash
npm install -g @revolut/revolut-x-cli && npm link @revolut/revolut-x-cli
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
4. Create a new API key — tick the **"Allow usage via Revolut X MCP and CLI"** checkbox
5. Prompt for the 64-character API key you receive after registration

Or do it step-by-step:

```bash
revx configure generate-keypair          # Creates Ed25519 keypair
# Register public key at exchange.revolut.com -> Profile -> API Keys
# Create API key — tick "Allow usage via Revolut X MCP and CLI"
revx configure set --api-key <64-char-key>
```

### Step 2: Verify Configuration

```bash
revx configure get             # Show config status (keys redacted)
revx configure path            # Print config directory path
```

## Config Commands

```bash
revx configure                          # Interactive setup wizard
revx configure get                      # Show config status (keys redacted)
revx configure set --api-key <key>      # Set API key
revx configure generate-keypair         # Generate Ed25519 keypair
revx configure path                     # Print config directory path
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
| The private key or config file `<path>` can't be read (EACCES) | The file isn't readable by this user | Make sure it belongs to the user, then `chmod 600 <path>` |
| `<path>` is not a file | A folder is in the way | Ask before moving the folder aside, then run `revx configure` |
| The private key `<path>` is missing | The API key is set but the key file is gone | Put the user's copy back at `<path>` if they have one. Otherwise `revx configure generate-keypair`, then register the new public key and create a new API key for it |
| The private key `<path>` is empty, holds a public key, is protected by a passphrase, is in OpenSSH format, is not a valid PEM private key, or is not an Ed25519 key | The key file is damaged or the wrong kind | Ask first. Then move it to a new name that doesn't exist yet, such as `mv -n <path> <path>.old-$(date +%s)`, run `revx configure generate-keypair`, register the new public key and create a new API key for it. Never delete the old file |
| The config file `<path>` is not valid JSON, is not a settings object, has an API key that is not 64 letters and digits, or has a private_key_path that is not text | `config.json` was damaged | `revx configure set --api-key <key>` writes it again |
| Authentication failed (401) | Invalid key or signature | Re-register public key at exchange.revolut.com |
| Network error | Connection/timeout failure | Check connectivity, retry |

---

## Next Steps

Once configured, explore:
- Check your balances, transactions, and order history — see `revx-account` skill
- View market prices and candles — see `revx-market` skill
- Place your first order — see `revx-trading` skill

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-market` | Currencies, pairs, tickers, candles, order book |
| `revx-account` | Balances, transaction history, order queries, trade history |
| `revx-trading` | Place and cancel orders |
| `revx-monitor` | Live price/indicator alerts |
| `revx-telegram` | Telegram notification setup |
| `revx-strategy` | Grid bot backtest, optimize, run |
