# RevolutX MCP Server

MCP (Model Context Protocol) server for the [Revolut X](https://exchange.revolut.com/) crypto exchange. Use natural language in Claude Desktop, Cursor, or any MCP-compatible client to query market data, check balances, place orders, and run grid backtests.

## How It Works

The server runs as a subprocess and communicates via stdin/stdout (STDIO transport). This is the standard mode for all MCP-compatible AI assistants.

```bash
node dist/index.js
```

Configure your MCP client to run:
- **Command:** `node`
- **Args:** `["/path/to/revolut-x-api/mcp/dist/index.js"]`

---

## Installation by Platform

### macOS

**Option A: From source**

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
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
      "args": ["/path/to/revolut-x-api/mcp/dist/index.js"]
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
      "args": ["/path/to/revolut-x-api/mcp/dist/index.js"]
    }
  }
}
```

### Windows

**Option A: From source**

```powershell
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
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
      "args": ["C:\\path\\to\\revolut-x-api\\mcp\\dist\\index.js"]
    }
  }
}
```

### Linux

**Option A: From source**

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api
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
      "args": ["/path/to/revolut-x-api/mcp/dist/index.js"]
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

---

## License

MIT — see [LICENSE](../LICENSE) in the repo root.
