---
name: revolut-x-trading
description: >
  Trade on Revolut X crypto exchange. Use this skill whenever the user wants to:
  place market or limit orders (only these two order types are supported for placement),
  check balances, view the order book, look up prices or tickers, manage active or
  historical orders, get order fills, fetch candle/OHLCV data, or do anything related
  to Revolut X trading or market data. Also use for authentication setup, API key
  generation, or request signing for Revolut X.
---

# Revolut X Trading Skill

## Capabilities Overview

| Category | Actions |
|---|---|
| **Account** | Check balances, view active orders, historical orders, order fills, trade history |
| **Market Data** | Tickers, order book (authenticated & public), OHLCV candles, recent trades, public last trades |
| **Trading** | Market orders, limit orders, TPSL orders, conditional orders, cancel by ID, cancel all |
| **Configuration** | List currencies, list tradeable pairs, manage API key setup |

---

## Authentication & Setup

**First-time users need to:**

### Step 1 — Generate a key pair
Generate an Ed25519 keypair. This can be done via built-in tooling, or manually:
```bash
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

### Step 2 — Create API key in Revolut X
1. Go to [exchange.revolut.com](https://exchange.revolut.com/) → **Profile**
2. Paste the **public key** (`public.pem` content, including `-----BEGIN/END KEY-----` lines)
3. Copy the 64-character alphanumeric API key Revolut generates

### Step 3 — Configure the key
Store the API key and private key path, then verify with check auth status.

### Request Signing (for manual API calls)
Every authenticated request requires 3 headers:
- `X-Revx-API-Key` — your 64-char key
- `X-Revx-Timestamp` — Unix timestamp in **milliseconds**
- `X-Revx-Signature` — Ed25519 signature, base64-encoded

Message to sign (concatenate with **no separators**):
```
{timestamp}{HTTP_METHOD}{/api/path}{query_string}{json_body}
```

See `references/auth-examples.md` for full Python and Node.js code examples.

---

## Order Types

### Market order
Executes immediately at the best available price.
Specify: `symbol`, `side` (`buy`/`sell`), and either `base_size` (base currency) or `quote_size`.

### Limit order
Executes at a specified price or better.
Specify: `symbol`, `side`, `price`, and `base_size` or `quote_size`.
- **Execution instructions**: `post_only` (maker only) or `allow_taker` (default)
- **Rate limit**: 1000 limit order placements per day

### Conditional order
Submitted only when a specific trigger price is reached. Specify a `trigger_price`, `trigger_direction` (`ge` = price ≥ trigger, `le` = price ≤ trigger), and the order type (`market` or `limit`).

### TPSL order (Take Profit / Stop Loss)
Sets or adjusts Take Profit and/or Stop Loss on a position. At least one of `take_profit` or `stop_loss` must be present.

---

## Common Workflows

### Check balance
Get available, reserved, and total amounts per currency.

### Place an order
Use the order placement action with the appropriate order type above.

### Cancel an order by ID
Provide the `venue_order_id` (UUID) to cancel a single active order.

### Cancel all active orders
Cancels all open limit, conditional, and TPSL orders on the account at once.

### Get order by ID
Retrieve full details for a specific order by its `venue_order_id`.

### Get fills for an order
Returns all trade fills associated with a specific `venue_order_id`.

### View active orders
Returns all currently open orders.

Filters:
- `symbols` — array of trading pairs, e.g. `["BTC-USD", "ETH-USD"]`
- `orderStates` — `pending_new` | `new` | `partially_filled`
- `orderTypes` — `limit` | `conditional` | `tpsl`
- `side` — `buy` | `sell`
- `cursor` — pagination cursor from previous response
- `limit` — max results per page

### Get historical orders
Returns past orders (filled, cancelled, rejected, replaced). Paginated (max 100 per page).

Filters:
- `symbols` — array of trading pairs
- `orderStates` — `filled` | `cancelled` | `rejected` | `replaced`
- `orderTypes` — `market` | `limit`
- `start_date` / `end_date` — Unix timestamps in milliseconds
- `cursor` — pagination cursor from previous response
- `limit` — max results per page

### Get ticker prices
Returns bid, ask, mid, and last price. Optionally filter by `symbols` array.

### Get order book (authenticated)
Up to 20 price levels for a given symbol. Optional `limit` parameter.
Returns `data.asks[]` and `data.bids[]` where each level is `{ price, quantity, orderCount }`, plus `metadata.timestamp`.

### Get public order book (no auth required)
`GET /public/order-book/{symbol}` — maximum 5 price levels. No API key needed.
Returns `data.asks` and `data.bids` arrays with price level fields (`p`, `q`, `no`, `pdt`, etc.) and `metadata.timestamp`.

### Get OHLCV candles
Parameters:
- `symbol` — trading pair
- `interval` — candle width: integer minutes (`1`, `5`, `15`, `30`, `60`, `240`, `1440`, etc.) or named string (`"5m"`, `"1h"`, `"4h"`, `"1d"`)
- `startDate` / `endDate` — Unix timestamps in milliseconds (optional; defaults to last 100 candles)
- Max 1000 candles per request: `(endDate - startDate) / interval ≤ 1000`

If no trading volume exists for a period, candle is based on mid price (bid/ask average).

### Public last trades (no auth required)
`GET /public/last-trades` — returns the latest 100 trades executed on the exchange across all pairs. No API key needed.
Response: `data[]` with fields `tdt` (trade datetime), `aid`, `anm` (asset), `p`/`pc` (price/currency), `q`/`qc` (quantity/currency), `tid` (transaction ID), `ve`/`vp` (venue), `pdt` (publication datetime).

### Recent trades (all)
Full paginated trade history for a symbol.

Filters:
- `startDate` / `endDate` — Unix timestamps in milliseconds
- `cursor` — pagination cursor
- `limit` — max results per page

### My trade history
Returns personal fill history for a given symbol. Paginated.

Filters:
- `startDate` / `endDate` — Unix timestamps in milliseconds
- `cursor` — pagination cursor
- `limit` — max results per page

---

## Error Handling

All errors extend `RevolutXError`. Handle these explicitly:

| Error | When |
|---|---|
| `AuthNotConfiguredError` | No API key or private key configured — run configure |
| `AuthenticationError` (401) | Invalid API key or signature |
| `ForbiddenError` (403) | Access denied |
| `RateLimitError` (429) | Rate limit exceeded — `err.retryAfter` contains the `Retry-After` response header value (milliseconds as a long number); wait that duration before retrying |
| `ValidationError` (400) | Request failed client-side schema validation — check `err.errors` |
| `OrderError` (400) | Order rejected by exchange (invalid params, insufficient funds, etc.) |
| `NotFoundError` (404) | Order or resource does not exist |
| `ConflictError` (409) | Conflicting request, e.g. timestamp skew — safe to retry |
| `ServerError` (5xx) | Exchange-side error — check `err.statusCode`, retry with backoff |
| `NetworkError` | Connection or timeout failure — retry with backoff |

On `RateLimitError`, the client does **not** retry automatically. `err.retryAfter` is the raw value from the `Retry-After` response header — a long number in milliseconds. May be `undefined` if the header was absent.

---

## Symbol Format

All symbols use `BASE-QUOTE` format: `BTC-USD`, `ETH-USD`, `SOL-EUR`, etc.
Use the list currency pairs action to see all valid pairs and their constraints (min/max order size, step sizes).

---

## Important Notes

- **Private keys are secret** — never share or include in any request
- Limit order placement has a **rate limit of 1000 requests/day**
- Candle `interval` accepts minutes as integer or named strings (`"5m"`, `"1h"`, `"4h"`, `"1d"`)
- The public order book (`/public/order-book/{symbol}`) and public last trades (`/public/last-trades`) require **no authentication**
- Timestamp drift > a few seconds will cause signature rejection; always use current system time
- Check min/max order sizes via the list currency pairs action before placing orders

For full auth code examples → see `references/auth-examples.md`

For full request/response schemas, field definitions, error codes, and query filters → see `references/schemas.md`
