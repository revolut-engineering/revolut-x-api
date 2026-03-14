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
| **Market Data** | Tickers, order book (public & authenticated), OHLCV candles, public/recent trades |
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
Specify: `symbol`, `side` (`buy`/`sell`), and either `size` (base currency) or `quote_size`.

### Limit order
Executes at a specified price or better.
Specify: `symbol`, `side`, `price`, and `size` or `quote_size`.
- **`time_in_force`**: `gtc` (good till cancelled) or `ioc` (immediate or cancel) or `fok` (fill or kill)
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
Returns all currently open orders. Can filter by `order_types` (limit, conditional, tpsl).

### Get historical orders
Returns past orders (filled, cancelled, rejected, replaced). Filterable by symbol, state, type, and date range. Paginated (max 100 per page).

### Get ticker prices
Returns bid, ask, mid, and last price for all pairs.

### Get order book (authenticated)
Up to 20 price levels for a given symbol.

### Get order book (public, no auth required)
Maximum 5 price levels. No API key needed.

### Get OHLCV candles
Parameters:
- `symbol` — trading pair
- `interval` — candle width in **minutes**: `1`, `5`, `15`, `30`, `60`, `240`, `1440`, `2880`, `5760`, `10080`, `20160`, `40320` (default: `5`)
- `since` / `until` — Unix timestamps in milliseconds (optional; defaults to last 100 candles)
- Max 1000 candles per request: `(until - since) / interval ≤ 1000`

If no trading volume exists for a period, candle is based on mid price (bid/ask average).

### Recent trades (authenticated)
Full paginated trade history for a symbol. Supports date range and cursor pagination.

### Public last trades (no auth required)
Returns the latest 100 trades across all pairs on the exchange. No API key needed.

### My trade history
Returns personal fill history for a given symbol. Paginated.

---

## Symbol Format

All symbols use `BASE-QUOTE` format: `BTC-USD`, `ETH-USD`, `SOL-EUR`, etc.
Use the list currency pairs action to see all valid pairs and their constraints (min/max order size, step sizes).

---

## Important Notes

- **Private keys are secret** — never share or include in any request
- Limit order placement has a **rate limit of 1000 requests/day**
- Candle `interval` is in **minutes as an integer**, not a named string
- The public order book and public last trades endpoints require **no authentication**
- Timestamp drift > a few seconds will cause signature rejection; always use current system time
- Check min/max order sizes via the list currency pairs action before placing orders

For full auth code examples → see `references/auth-examples.md`

For full request/response schemas, field definitions, error codes, and query filters → see `references/schemas.md`
