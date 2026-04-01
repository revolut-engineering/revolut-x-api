# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Monorepo for Revolut X crypto exchange tooling. Three npm workspace packages:

- **`api/`** — Typed HTTP client (zero runtime deps besides zod). Ed25519 request signing.
- **`cli/`** — `revx` CLI for trading, monitoring, grid bots (Commander.js, chalk, Decimal.js).
- **`mcp/`** — MCP server with 23 tools for AI assistants (esbuild single bundle).
- **`skills/`** — Claude Code skills (not a workspace package).

## Build

```bash
npm ci                        # install all workspaces
npm run build                 # build all (api must build first — it's a dependency)
```

Build order matters: **api -> cli, mcp**. For individual packages:

```bash
npm run build -w api          # or: cd api && npm run build
npm run build -w cli
npm run build -w mcp
```

Dev build (targets `https://revx.revolut.codes` instead of production):

```bash
cd api && npm run build:dev
```

## Test

Vitest across all packages. Run from repo root:

```bash
npm test                      # all workspaces
npm test -w api               # API only
npm test -w cli               # CLI only
npm test -w mcp               # MCP only
```

Run a single test file:

```bash
npx vitest run tests/client/orders.test.ts -w api
```

Coverage thresholds: api 74% statements, cli 32% statements. Tests use `nock` for HTTP mocking.

## Lint & Format

```bash
npm run lint                  # ESLint across all packages
npm run lint:fix              # auto-fix
npm run format:check          # Prettier check
npm run format                # Prettier write
```

## Code Conventions

- **TypeScript 5.7**, strict mode, ESM (`"type": "module"`)
- **`var`** keyword mandatory for local variables (not `let`/`const`)
- **Decimal.js** for all financial math — never native floats for money/quantities
- **Zod schemas** for API response validation
- **No comments** in production code — code should be self-documenting
- **Atomic file writes** for state persistence: write to `.tmp` file, then `fs.renameSync()`
- **Static imports** for constants, enums, utility methods
- Prettier: double quotes, semicolons, trailing commas, 80 char width
- ESLint: `no-explicit-any` is a warning (not error), empty catch blocks allowed

## Symbol Format

Requests use dashes (`BTC-USD`), responses use slashes (`BTC/USD`).

## Architecture

**API client** (`api/src/client.ts`): `RevolutXClient` is the main entry point. Auth uses Ed25519 keypairs stored in `~/.config/revolut-x/`. Requests are signed with three headers: `X-Revx-API-Key`, `X-Revx-Timestamp`, `X-Revx-Signature`. HTTP layer has automatic retry with exponential backoff (retries on 429, 409, 5xx). Errors extend `RevolutXError` with specific subtypes (AuthenticationError, RateLimitError, OrderError, etc.).

**CLI** (`cli/src/bin/revx.ts`): Commander.js with hierarchical subcommands in `commands/`. Business logic lives in `engine/` (grid bot, monitor, candle cache). State persisted as JSON in `db/` (grid-store uses atomic writes). Technical indicators (RSI, EMA, MACD, Bollinger, etc.) in `shared/indicators/`.

**MCP server** (`mcp/src/index.ts`): Tools registered in `server.ts`, implementations in `tools/`. Some tools call the API directly, others generate `revx` CLI commands for the user to run. Built as a single esbuild bundle (~500KB).

## Testing Patterns

- API tests mock HTTP with `nock` — call `nock.cleanAll()` after each test
- Test utilities in `api/tests/helpers/test-utils.ts` (mock data, test client factory)
- CLI tests mock the RevolutXClient directly
- MCP tests verify tool registration and response formatting
