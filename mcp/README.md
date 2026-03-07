# RevolutX MCP Server

MCP (Model Context Protocol) server for the [Revolut X](https://exchange.revolut.com/) crypto exchange. Use natural language in Claude Desktop, Cursor, or any MCP-compatible client to query market data, check balances, place orders, and run grid backtests.

## Ways to Run

### 1. Stdio (default) — Claude Desktop, Cursor, CLI

The server runs as a subprocess and communicates via stdin/stdout. This is the standard mode for AI assistants.

```bash
node dist/index.js
# or with args
node dist/index.js
```

Configure your MCP client to run:
- **Command:** `node`
- **Args:** `["/path/to/revolutx-ai/mcp/dist/index.js"]`

### 2. HTTP — remote clients

The server exposes an HTTP endpoint for Streamable HTTP transport. Use when clients connect over the network.

```bash
node dist/index.js --transport http
```

Listens on `0.0.0.0:8000` by default. Endpoint: `http://localhost:8000/mcp`

Environment variables:
- `MCP_PORT` — port (default: 8000)
- `MCP_HOST` — bind address (default: 0.0.0.0)

---

## Installation by Platform

### macOS

**Option A: From source**

```bash
git clone https://github.com/revolut-engineering/revolutx-ai.git
cd revolutx-ai
cd api && npm ci && npm run build && cd ..
cd mcp && npm ci && npm run build
```

**Option B: Claude Desktop (Anthropic directory)**

Search for **RevolutX** in the MCP directory and click Install.

**Option C: Manual — Claude Desktop**

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolutx-ai/mcp/dist/index.js"]
    }
  }
}
```

**Option D: Cursor**

Add to Cursor MCP settings or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolutx-ai/mcp/dist/index.js"]
    }
  }
}
```

### Windows

**Option A: From source**

```powershell
git clone https://github.com/revolut-engineering/revolutx-ai.git
cd revolutx-ai
cd api; npm ci; npm run build; cd ..
cd mcp; npm ci; npm run build
```

**Option B: Claude Desktop**

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["C:\\path\\to\\revolutx-ai\\mcp\\dist\\index.js"]
    }
  }
}
```

### Linux

**Option A: From source**

```bash
git clone https://github.com/revolut-engineering/revolutx-ai.git
cd revolutx-ai
(cd api && npm ci && npm run build)
(cd mcp && npm ci && npm run build)
```

**Option B: Claude Desktop**

Edit `~/.config/Claude/claude_desktop_config.json` (or equivalent):

```json
{
  "mcpServers": {
    "revolutx": {
      "command": "node",
      "args": ["/path/to/revolutx-ai/mcp/dist/index.js"]
    }
  }
}
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REVOLUTX_CONFIG_DIR` | `~/.config/revolut-x` | Config directory for API keys |
| `REVOLUTX_WORKER_URL` | `http://localhost:8080` | Worker URL (alerts, Telegram) |
| `MCP_PORT` | 8000 | HTTP server port |
| `MCP_HOST` | 0.0.0.0 | HTTP bind address |

### First-time setup

After installing, ask your AI assistant:

> "Set up my Revolut X API keys"

This runs `generate_keypair`, `configure_api_key`, and `check_auth_status` in sequence.

---

## Development

```bash
cd mcp
npm install
npm run build      # tsc
npm run dev       # tsx src/index.ts (stdio)
npm test
```

For HTTP mode during development:

```bash
MCP_PORT=8000 node dist/index.js --transport http
```

---

## License

MIT — see [LICENSE](../LICENSE) in the repo root.
