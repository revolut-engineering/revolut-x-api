# Revolut X

Open-source monorepo for [Revolut X](https://exchange.revolut.com/) crypto exchange tooling.

## Packages

| Package | Description |
|---|---|
| `api/` | Typed HTTP client for Revolut X REST API (zero runtime deps, Node.js built-ins + zod) |
| `cli/` | `revx` CLI — trading, monitoring, grid bots (Commander.js, chalk, cli-table3) |
| `mcp/` | MCP server — 23 tools for AI assistants (@modelcontextprotocol/sdk, esbuild bundle) |
| `skills/` | Claude Code skills for CLI and trading workflows |

## Setup

```bash
npm ci                            # Install all workspace dependencies
npm run build                     # Build all packages
```

Individual packages (order matters — api first):
```bash
cd api && npm run build && cd ..  # HTTP client (dependency for cli and mcp)
cd cli && npm run build && cd ..  # CLI
cd mcp && npm run build && cd ..  # MCP server bundle
```

Dev build (targets `https://revx.revolut.codes`):
```bash
cd api && npm run build:dev && cd ..
```

Install CLI globally after building:
```bash
cd cli && npm link
```

## Testing

```bash
npm test                          # All workspaces
npm test -w api                   # API client only
npm test -w cli                   # CLI only
npm test -w mcp                   # MCP server only
```

## Linting & Formatting

```bash
npm run lint                      # ESLint across api, cli, mcp
npm run lint:fix                  # Auto-fix
npm run format                    # Prettier
npm run format:check              # Check only
```

## Code Conventions

- **TypeScript 5.7**, strict mode, ESM (`"type": "module"`)
- **`var` keyword** mandatory for local variables
- **Decimal.js** for all financial math — never use native floats for money
- **Zod schemas** for API response validation
- **Atomic file writes** for state persistence (write to `.tmp`, then rename)
- **No comments** in production code — code should be self-documenting
- **Static imports** for constants, enums, utility methods

## Architecture

```
api/src/
  client.ts              # RevolutXClient — main entry point
  auth/                  # Ed25519 keypair generation + request signing
  http/                  # Fetch-based HTTP client with retry
  types/                 # TypeScript type definitions
  validation/            # Zod schemas

cli/src/
  bin/revx.ts            # Entry point
  commands/              # 9 command files (Commander.js)
  engine/                # Monitor engine, grid bot, candle cache
  shared/backtest/       # Backtesting engine
  db/                    # Local JSON state (store.ts, grid-store.ts)
  util/                  # Client init, error handling, parsing, passkey, session
  output/                # Table/JSON formatter

mcp/src/
  index.ts               # MCP server setup
  tools/                 # 11 tool implementation files
```

## Key Patterns

- **CLI commands** use `Commander.js` with hierarchical subcommands
- **MCP tools** either call the API directly or generate `revx` CLI commands
- **Error handling**: API errors extend `RevolutXError` with specific subtypes (AuthenticationError, RateLimitError, OrderError, etc.)
- **Session auth**: Scrypt-hashed passkey with timing-safe comparison, session tokens in `/tmp/revx_sessions/`
- **Config storage**: `~/.config/revolut-x/` (macOS/Linux), `%APPDATA%\revolut-x\` (Windows)

## Authentication

Ed25519 keypair-based. Requests signed with:
- `X-Revx-API-Key` — 64-char API key
- `X-Revx-Timestamp` — Unix ms
- `X-Revx-Signature` — Ed25519 signature (base64)

Private keys never leave the filesystem. File permissions 0o600.

## Build Output

- `api/` → TypeScript compiled to `dist/`
- `cli/` → TypeScript compiled to `dist/`, binary registered as `revx`
- `mcp/` → esbuild single bundle at `dist/index.js` (~500KB)

All `dist/` directories are gitignored.
