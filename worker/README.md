# RevolutX Worker

Alert engine and REST API service for RevolutX. Monitors cryptocurrency pairs on Revolut X, evaluates technical indicator conditions, and sends Telegram notifications when alerts trigger.

## Features

- **10 alert types** — price, RSI, EMA cross, MACD, Bollinger Bands, volume spike, spread, OBI, price change %, ATR breakout
- **Background tick loop** — periodically evaluates all enabled alerts against live market data
- **Telegram notifications** — sends alerts to configured Telegram bots/chats
- **REST API** — full CRUD for alerts, Telegram connections, events, and worker control
- **SQLite storage** — lightweight, zero-config database with WAL mode
- **Pair validation** — validates trading pairs against the Revolut X API (when credentials are configured)

## Prerequisites

- Node.js 20+
- npm

## Quick Start

```bash
# Install dependencies
npm install

# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

The server starts on `http://127.0.0.1:8080` by default.

## Standalone Installation

### From GitHub Artifact

1. Download the `revolutx-worker` artifact from the latest [GitHub Actions build](../../actions/workflows/build.yml)
2. Extract and install:

```bash
mkdir revolutx-worker && cd revolutx-worker
tar -xzf revolutx-worker.tar.gz
npm ci --omit=dev
```

3. Run:

```bash
node dist/index.js
```

4. Customise (optional):

```bash
# Change port
node dist/index.js --port 9090

# Use a custom config directory
node dist/index.js --config-dir /path/to/config
```

### From Source

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git
cd revolut-x-api/worker
npm install
npm run build
node dist/index.js
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REVOLUTX_WORKER_HOST` | `127.0.0.1` | Bind address |
| `REVOLUTX_WORKER_PORT` | `8080` | Listen port |
| `REVOLUTX_WORKER_TICK_SEC` | `10` | Alert evaluation interval (seconds) |
| `REVOLUTX_CONFIG_DIR` | Platform-dependent (see below) | Config and database directory |
| `REVOLUTX_CORS_ORIGINS` | `http://localhost:3000,http://localhost:5173` | Allowed CORS origins (comma-separated) |
| `LOG_LEVEL` | `info` | Fastify log level (`debug`, `info`, `warn`, `error`) |

### CLI Arguments

```bash
node dist/index.js [options]

Options:
  --host <address>    Bind address (overrides REVOLUTX_WORKER_HOST)
  --port <number>     Listen port (overrides REVOLUTX_WORKER_PORT)
  --config-dir <path> Config directory (overrides REVOLUTX_CONFIG_DIR)
```

### Config Directory

The config directory stores the SQLite database, API credentials, and key pairs. Default locations:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/revolutx-mcp/` |
| Linux | `~/.config/revolutx-mcp/` |
| Windows | `%APPDATA%\revolutx-mcp\` |

Override with `--config-dir` or `REVOLUTX_CONFIG_DIR`.

**Contents:**

| File | Description |
|------|-------------|
| `revolutx.db` | SQLite database (alerts, connections, events) |
| `config.json` | API key and private key path |
| `private.pem` | Ed25519 private key (for request signing) |
| `public.pem` | Ed25519 public key |

## API Reference

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with uptime, alert/connection counts |

### Alerts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/alerts` | List alerts (supports `?limit`, `?offset`, `?enabled`, `?alert_type`) |
| `POST` | `/api/alerts` | Create an alert |
| `GET` | `/api/alerts/types` | List available alert types with config schemas |
| `GET` | `/api/alerts/:id` | Get a single alert |
| `PATCH` | `/api/alerts/:id` | Update an alert (enable/disable, change interval) |
| `DELETE` | `/api/alerts/:id` | Delete an alert |

### Telegram

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/telegram/connections` | List Telegram connections |
| `POST` | `/api/telegram/connections` | Add a Telegram connection |
| `PATCH` | `/api/telegram/connections/:id` | Update a connection (enable/disable, rename) |
| `DELETE` | `/api/telegram/connections/:id` | Delete a connection |
| `POST` | `/api/telegram/connections/:id/test` | Send a test message |

### Events

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | List events (supports `?limit`, `?offset`, `?category`) |

### Worker Control

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/worker/status` | Worker status (running, tick info, uptime) |
| `POST` | `/api/worker/restart` | Restart the tick loop |
| `POST` | `/api/worker/stop` | Stop the tick loop |
| `GET` | `/api/worker/settings` | Get worker settings |
| `PATCH` | `/api/worker/settings` | Update worker settings (tick interval) |

### Pairs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pairs` | List available trading pairs (requires credentials) |

## Database

- **Engine:** SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- **Location:** `<config-dir>/revolutx.db`
- **Mode:** WAL (Write-Ahead Logging) for concurrent read performance
- **Migrations:** Applied automatically on startup
- **Tables:** `alerts`, `telegram_connections`, `events`

## Docker

```bash
# Start Worker + Web UI
docker compose up -d

# View logs
docker compose logs -f worker

# Stop and remove volumes
docker compose down -v
```

## Testing

```bash
# Run all tests
npm test

# Run with watch mode
npx vitest

# Type check
npm run lint
```

## Project Structure

```
worker/src/
├── index.ts              # Entry point, CLI arg parsing
├── config.ts             # Environment + settings loader
├── app.ts                # Fastify app factory, lifecycle
├── db/
│   ├── connection.ts     # SQLite connection + path resolution
│   ├── schema.ts         # Table DDL + migrations
│   └── repositories.ts   # Alert, Connection, Event CRUD
├── engine/
│   ├── runner.ts         # Background tick loop
│   └── candle-cache.ts   # In-memory candle cache
├── routes/
│   ├── index.ts          # Route registration
│   ├── health.ts         # GET /health
│   ├── alerts.ts         # Alert CRUD endpoints
│   ├── telegram.ts       # Telegram connection endpoints
│   ├── events.ts         # Event list endpoint
│   ├── worker-ops.ts     # Worker control endpoints
│   └── pairs.ts          # Trading pairs endpoint
└── shared/               # Auth, indicators, models (mirrored from MCP)
```
