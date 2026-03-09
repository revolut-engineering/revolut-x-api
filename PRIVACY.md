# Privacy Policy — RevolutX MCP Server

Last updated: 2026-02-28

---

## What This Server Does

RevolutX is a **local MCP server** that runs entirely on your machine (via STDIO transport). There is no cloud component, no hosted backend, and no third-party analytics. The companion Worker service also runs locally and stores data in a local SQLite database.

---

## Data Accessed

### API Credentials (local storage)

- **Private key** (Ed25519) and **API key** are stored in a platform-specific config directory with `0600` file permissions (owner read/write only):
  - macOS: `~/.config/revolutx-mcp/`
  - Linux: `~/.config/revolutx-mcp/`
  - Windows: `%APPDATA%\revolutx-mcp\`
- The private key **never leaves your machine** — it is used only to sign API requests locally.
- You can override the config directory with the `REVOLUTX_CONFIG_DIR` environment variable.

### Exchange Data (fetched on demand)

- Account balances, order books, tickers, candlestick data, public trades, active orders, and trade history are fetched from the Revolut X API on demand when you invoke the corresponding MCP tools.
- This data is **not persisted** — it is returned to the LLM client and discarded.

### Alert and Event Data (local SQLite)

- Alert configurations, trigger history, Telegram connection details, and system events are stored in a local SQLite database managed by the Worker service.
- The database file lives inside the config directory or the `revolutx-data` Docker volume.

---

## External Services

RevolutX communicates with exactly two external services:

| Service | Domain | Purpose | When |
|---------|--------|---------|------|
| **Revolut X API** | `revx.revolut.com` | Account data, market data, order placement | Every tool call that accesses exchange data |
| **Telegram Bot API** | `api.telegram.org` | Send alert notifications | Only when Telegram is configured and an alert triggers |

No data is sent to any other external service. There is no telemetry, analytics, crash reporting, or usage tracking of any kind.

---

## Telegram Integration

- Telegram is **entirely opt-in** — no Telegram calls are made unless you explicitly add a bot connection via the `telegram_add_connection` tool.
- The Telegram bot token is stored locally in the SQLite database.
- Bot tokens are **redacted** in tool responses (only the last 4 characters are shown).
- You can remove all Telegram connections at any time using the `telegram_delete_connection` tool.

---

## Security Model

- **Private key isolation:** Your Ed25519 private key never leaves your machine. API requests are signed locally using the key.
- **File permissions:** Credential files are created with `0600` permissions (owner read/write only).
- **Local-only database:** SQLite is local and is not exposed over the network.
- **STDIO only:** The MCP server communicates exclusively via STDIO transport (spawned as a child process), with no network listener.
- **No credential transmission:** API keys and private keys are never included in MCP tool responses or sent to LLM providers.

---

## Data Sharing

RevolutX does **not** share your data with any party beyond the two external services listed above. Specifically:

- No data is sold or shared with advertisers
- No usage data is collected or transmitted
- No crash reports are sent to any service
- MCP tool responses contain only the data you requested — no tracking identifiers are appended

---

## Data Retention

All data is stored locally on your machine. To remove all stored data:

- **Config directory:** Delete the config directory listed above (or the path set in `REVOLUTX_CONFIG_DIR`)
- **Docker volumes:** Run `docker compose down -v` to remove the Worker database volume
- **No remote data:** Since no data is stored remotely, local deletion is complete deletion

---

## Changes to This Policy

Changes to this privacy policy will be reflected in this file and in the repository commit history. The "Last updated" date at the top of this document indicates the most recent revision.

---

## Contact

For questions about this privacy policy, open an issue at [github.com/revolut-engineering/revolut-x-api/issues](https://github.com/revolut-engineering/revolut-x-api/issues).
