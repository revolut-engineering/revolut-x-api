# revolut-x-api

Monorepo for open-source tooling around the [Revolut X](https://exchange.revolut.com/) crypto exchange.

## Packages

| Package | Description |
|---------|-------------|
| [`api/`](api/) | Typed HTTP client for the Revolut X REST API. Zero runtime dependencies — Node.js built-ins only. |
| [`mcp/`](mcp/) | MCP server exposing 23 tools for market data, account management, orders, monitoring, and grid strategy backtests. Use with Claude Desktop, Claude Code, or any MCP-compatible client. |
| [`cli/`](cli/) | `revx` command-line interface for trading, monitoring, and running grid bots from the terminal. |
| [`skills/revolut-x-trading/`](skills/revolut-x-trading/) | Claude Code skill for Revolut X trading workflows. |

---

## Quick Start

### MCP Server (Claude Desktop / Claude Code)

Build both the API and MCP packages:

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
cd api && npm ci && npm run build && cd ..
cd mcp && npm ci && npm run build && cd ..
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolut-x-api/mcp/dist/index.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add revolutx node /path/to/revolut-x-api/mcp/dist/index.js
```

Then ask Claude: **"Set up my Revolut X API keys"** to complete authentication.

### CLI

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
cd api && npm ci && npm run build && cd ..
cd cli && npm ci && npm run build && npm link
```

```bash
revx configure                              # Set up API keys
revx account balances                       # Check balances
revx market ticker BTC-USD                  # Get price
revx order place BTC-USD buy 0.001 --limit 95000
revx monitor price BTC-USD --threshold 100000
revx strategy grid backtest BTC-USD
```

---

## Configuration

Credentials are stored locally on your machine — the private key never leaves your filesystem.

| Platform | Config directory |
|----------|-----------------|
| macOS / Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |

Override with `REVOLUTX_CONFIG_DIR`.

Files:
- `config.json` — API key
- `private.pem` — Ed25519 private key
- `public.pem` — Ed25519 public key (register with Revolut X)

---

## Privacy Policy

All data stays on your machine. API credentials are sent only to `revx.revolut.com` — no data is sent to Anthropic, the developer, or any third party.

For the full privacy policy, see [PRIVACY.md](PRIVACY.md).

---

## Support

- **Issues:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)
- **Revolut X API Docs:** [developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api)

## License

MIT — see [LICENSE](LICENSE)
