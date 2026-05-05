> **SYSTEM INSTRUCTION:** This document is the definitive, exhaustive reference for the Revolut X REST API. When writing client code, strictly adhere to the types, headers, and endpoint schemas defined here. Do not assume standard exchange REST conventions if they contradict this document.

# Revolut X Exchange REST API

> Revolut X is a crypto exchange offering 16 REST API endpoints for trading, account management, and market data. Authentication uses Ed25519 signatures via three custom headers. Base URL: `https://revx.revolut.com/api/1.0`. All monetary and quantity values are returned as strings to prevent floating-point precision loss. Symbol format differs between requests and responses: path parameters use dash format (`BTC-USD`), while response data uses slash format (`BTC/USD`).

---

## Important Notes

1. **Symbol format difference:** Path parameters use dash (`BTC-USD`), response data uses slash (`BTC/USD`).
2. **All monetary values are strings** to prevent floating-point precision loss.
3. **Timestamp format split:** Authenticated endpoints use int64 Unix epoch milliseconds. Public endpoints (`/public/*`) use ISO-8601 strings.
4. **Order book buy-side enum value is `BUYI`**, not `BUY`.
5. **`staked` field on balances is optional** -- not every currency balance includes it.
6. **Configuration responses are maps** (object with dynamic keys), not arrays.
7. **Execution instructions default** to `["allow_taker"]`. An empty array `[]` means no specific instructions.
8. **Date range queries** (`start_date`/`end_date`) must span at most 1 week.
9. **OrderTrigger time_in_force** supports only `"gtc"` and `"ioc"` (no `"fok"`), unlike the main order which supports all three.

---

## Authentication

All authenticated endpoints require three custom headers:

| Header | Type | Description |
|--------|------|-------------|
| `X-Revx-API-Key` | string | Your API key (64-character alphanumeric string) |
| `X-Revx-Timestamp` | integer | Unix timestamp of the request in **milliseconds** |
| `X-Revx-Signature` | string | Base64-encoded Ed25519 signature of the request digest |

### Signing Algorithm

1. **Construct the message** by concatenating (no separators):
   - Timestamp (same as `X-Revx-Timestamp`)
   - HTTP method (uppercase: `GET`, `POST`, `DELETE`)
   - Request path (starting from `/api`, e.g., `/api/1.0/orders/active`)
   - Query string (without `?`, e.g., `limit=10`)
   - Request body (minified JSON, if present)

2. **Sign** the concatenated string with your Ed25519 private key.
3. **Base64-encode** the signature.

**Example message to sign:**
```
1765360896219POST/api/1.0/orders{"client_order_id":"3b364427-1f4f-4f66-9935-86b6fb115d26","symbol":"BTC-USD","side":"BUY","order_configuration":{"limit":{"base_size":"0.1","price":"90000.1"}}}
```

### Python Signing Example

```python
import time
import base64
from pathlib import Path
from nacl.signing import SigningKey
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

pem_data = Path("private.pem").read_bytes()
private_key_obj = serialization.load_pem_private_key(pem_data, password=None, backend=default_backend())
raw_private = private_key_obj.private_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PrivateFormat.Raw,
    encryption_algorithm=serialization.NoEncryption()
)

timestamp = str(int(time.time() * 1000))
method = "GET"
path = "/api/1.0/orders/active"
query = "order_states=new,partially_filled&limit=10"
body = ""

message = f"{timestamp}{method}{path}{query}{body}".encode("utf-8")
signing_key = SigningKey(raw_private)
signed = signing_key.sign(message)
signature = base64.b64encode(signed.signature).decode()
```

---

## Base URL

`https://revx.revolut.com/api/1.0`

---

## Error Handling

All errors return the same JSON structure:

```json
{
  "error_id": "7d85b5e7-d0f0-4696-b7b5-a300d0d03a5e",
  "message": "Human-readable error description",
  "timestamp": 3318215482991
}
```

**ErrorResponse fields:**

| Field | Type | Description |
|-------|------|-------------|
| error_id | string (uuid) | Unique identifier for this error occurrence |
| message | string | Human-readable description of the error |
| timestamp | integer (int64) | Time the error occurred in Unix epoch milliseconds |

**HTTP error codes:**

| Status | Meaning | Example Message |
|--------|---------|-----------------|
| 400 | Bad Request | `"No such pair: BTC-BTC"` |
| 401 | Unauthorized | `"API key can only be used for authentication from whitelisted IP"` |
| 403 | Forbidden | `"Forbidden"` |
| 404 | Not Found | `"Order with ID '7d85b5e7-...' not found."` |
| 409 | Conflict | `"Request timestamp is in the future"` |
| 5XX | Server Error | `"Something went wrong!"` |

---

## Rate Limits

| Tier | Limit | Applies To |
|------|-------|-----------|
| Authenticated | 1000 requests per minute | All authenticated endpoints |
| Public | 20 requests per 10 seconds | `GET /public/last-trades`, `GET /public/order-book/{symbol}` |

---

## Pagination

Four endpoints use cursor-based pagination: `GET /orders/active`, `GET /orders/historical`, `GET /trades/all/{symbol}`, `GET /trades/private/{symbol}`.

**Pattern:**
- Responses include `metadata.next_cursor` (string). If present, pass it as the `cursor` query parameter on the next request.
- Use the `limit` query parameter to control page size (integer, range: 1-100, default: 100).
- Responses include `metadata.timestamp` (int64, Unix epoch milliseconds).

---

## Endpoints

### Account

---

### GET /balances

Get all crypto and fiat account balances for the authenticated user.

**Auth:** Required
**Errors:** 401, 403, 409, 5XX

**Parameters:** None (besides auth headers)

**Response (200):** Bare array of `AccountBalanceEntry` (no `data` wrapper).

**Example response:**
```json
[
  {"currency": "BTC", "available": "1.25000000", "reserved": "0.10000000", "total": "1.35000000"},
  {"currency": "ETH", "available": "10.00000000", "reserved": "0.00000000", "staked": "32.00000000", "total": "10.00000000"},
  {"currency": "USD", "available": "5400.50", "reserved": "100.00", "total": "5500.50"}
]
```

---

### Configuration

---

### GET /configuration/currencies

Get configuration for all currencies used on the exchange.

**Auth:** Required
**Errors:** 401, 403, 409, 5XX

**Parameters:** None (besides auth headers)

**Response (200):** Object map where each key is a currency code and each value is a `Currency` object. **Not an array.**

**Example response:**
```json
{
  "BTC": {"symbol": "BTC", "name": "Bitcoin", "scale": 8, "asset_type": "crypto", "status": "active"},
  "ETH": {"symbol": "ETH", "name": "Ethereum", "scale": 8, "asset_type": "crypto", "status": "active"}
}
```

---

### GET /configuration/pairs

Get configuration for all traded currency pairs.

**Auth:** Required
**Errors:** 401, 403, 409, 5XX

**Parameters:** None (besides auth headers)

**Response (200):** Object map where each key is a currency pair code (slash format, e.g., `BTC/USD`) and each value is a `CurrencyPair` object. **Not an array.**

**Example response:**
```json
{
  "BTC/USD": {
    "base": "BTC", "quote": "USD", "base_step": "0.0000001", "quote_step": "0.01",
    "min_order_size": "0.0000001", "max_order_size": "1000", "min_order_size_quote": "0.01", "status": "active"
  },
  "ETH/EUR": {
    "base": "ETH", "quote": "EUR", "base_step": "0.0000001", "quote_step": "0.01",
    "min_order_size": "0.00001", "max_order_size": "9000", "min_order_size_quote": "0.01", "status": "active"
  }
}
```

---

### Orders

---

### POST /orders

Place a new order (limit or market).

**Auth:** Required
**Errors:** 400, 401, 403, 409, 5XX

**Parameters:** None (besides auth headers)

**Request body:** `OrderPlacementRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| client_order_id | string (uuid) | yes | Unique identifier for idempotency |
| symbol | string | yes | Trading pair symbol (dash format, e.g., `BTC-USD`) |
| side | string | yes | `"buy"` or `"sell"` |
| order_configuration | object | yes | Must contain exactly one of `limit` or `market` |

**order_configuration.limit:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| price | string (decimal) | yes | The limit price |
| base_size | string (decimal) | one of base_size/quote_size | Amount in base currency |
| quote_size | string (decimal) | one of base_size/quote_size | Amount in quote currency |
| execution_instructions | array of string | no | `["allow_taker"]` (default), `["post_only"]`, or `[]` |

**order_configuration.market:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| base_size | string (decimal) | one of base_size/quote_size | Amount in base currency |
| quote_size | string (decimal) | one of base_size/quote_size | Amount in quote currency |

**Note on `time_in_force`:** This field cannot be set during order placement. Limit orders default to `gtc` (good till cancelled). Market orders are always `ioc` (immediate or cancel). The `time_in_force` field appears only in the `Order` response object.

**Example request (limit order by base size with execution instructions):**
```json
{
  "client_order_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "symbol": "BTC-USD",
  "side": "sell",
  "order_configuration": {
    "limit": {"base_size": "0.1", "price": "50000.50", "execution_instructions": ["post_only"]}
  }
}
```

**Example request (limit order by quote size):**
```json
{
  "client_order_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "symbol": "BTC-USD",
  "side": "buy",
  "order_configuration": {
    "limit": {"quote_size": "0.1", "price": "50000.50"}
  }
}
```

**Example request (market order by quote size):**
```json
{
  "client_order_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "symbol": "BTC-USD",
  "side": "sell",
  "order_configuration": {
    "market": {"quote_size": "0.1"}
  }
}
```

**Response (200):** `{ data: OrderPlacementResult }` -- note: `data` is a **single object**, not an array.

| Field | Type | Description |
|-------|------|-------------|
| venue_order_id | string (uuid) | System-generated order ID |
| client_order_id | string (uuid) | Client-provided order ID |
| state | string | Order state: `"pending_new"` \| `"new"` \| `"partially_filled"` \| `"filled"` \| `"cancelled"` \| `"rejected"` \| `"replaced"` |

**Example response:**
```json
{
  "data": {"venue_order_id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b", "client_order_id": "984a4d8a-2a9b-4950-822f-2a40037f02bd", "state": "new"}
}
```

---

### GET /orders/active

Get active orders for the authenticated user with optional filters.

**Auth:** Required
**Errors:** 400, 401, 403, 409, 5XX
**Pagination:** Yes (cursor-based)

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbols | query | string (comma-separated) | no | Filter by currency pairs, e.g., `BTC-USD,ETH-USD`. If omitted, no filter is applied (returns all) |
| order_states | query | string (comma-separated) | no | Filter by state: `pending_new`, `new`, `partially_filled`. If omitted, no filter is applied (returns all) |
| order_types | query | string (comma-separated) | no | Filter by type: `limit`, `conditional`, `tpsl`. If omitted, no filter is applied (returns all) |
| side | query | string | no | `"buy"` or `"sell"`. If omitted, no filter is applied (returns both) |
| cursor | query | string | no | Pagination cursor from previous response |
| limit | query | integer | no | Max records (1-100, default: 100) |

**Response (200):** `{ data: [Order], metadata: { timestamp, next_cursor? } }`

**Example response:**
```json
{
  "data": [
    {
      "id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",
      "client_order_id": "984a4d8a-2a9b-4950-822f-2a40037f02bd",
      "symbol": "BTC/USD", "side": "buy", "type": "limit",
      "quantity": "0.002", "filled_quantity": "0", "leaves_quantity": "0.002",
      "price": "98745", "status": "new", "time_in_force": "gtc",
      "execution_instructions": ["allow_taker"],
      "created_date": 3318215482991, "updated_date": 3318215482991
    }
  ],
  "metadata": {"timestamp": 3318215482991, "next_cursor": "GF0ZT0xNzY0OTMx..."}
}
```

---

### GET /orders/historical

Get historical (completed) orders for the authenticated user.

**Auth:** Required
**Errors:** 400, 401, 403, 409, 5XX
**Pagination:** Yes (cursor-based)

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbols | query | string (comma-separated) | no | Filter by currency pairs, e.g., `BTC-USD,ETH-USD`. If omitted, no filter is applied (returns all) |
| order_states | query | string (comma-separated) | no | Filter by state: `filled`, `cancelled`, `rejected`, `replaced`. If omitted, no filter is applied (returns all) |
| order_types | query | string (comma-separated) | no | Filter by type: `market`, `limit`. If omitted, no filter is applied (returns all) |
| start_date | query | integer (int64) | no | Start timestamp in Unix epoch ms. Defaults to `end_date - 1 week` |
| end_date | query | integer (int64) | no | End timestamp in Unix epoch ms. Defaults to `start_date + 1 week` or now. **Max range: 1 week** |
| cursor | query | string | no | Pagination cursor from previous response |
| limit | query | integer | no | Max records (1-100, default: 100) |

**Response (200):** `{ data: [Order], metadata: { timestamp, next_cursor? } }`

**Example response:**
```json
{
  "data": [
    {
      "id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",
      "client_order_id": "984a4d8a-2a9b-4950-822f-2a40037f02bd",
      "symbol": "BTC/USD", "side": "buy", "type": "limit",
      "quantity": "0.002", "filled_quantity": "0", "leaves_quantity": "0.002",
      "price": "98745", "status": "filled", "time_in_force": "gtc",
      "execution_instructions": ["allow_taker"],
      "created_date": 3318215482991, "updated_date": 3318215482991
    }
  ],
  "metadata": {"timestamp": 3318215482991, "next_cursor": "GF0ZT0xNzY0OTMx..."}
}
```

**Important differences from GET /orders/active:**
- `order_states` values are different: `filled`, `cancelled`, `rejected`, `replaced` (not `pending_new`, `new`, `partially_filled`)
- `order_types` values are different: `market`, `limit` (not `limit`, `conditional`, `tpsl`)
- Has `start_date`/`end_date` filters (active orders does not)

---

### GET /orders/{venue_order_id}

Retrieve a specific order by its venue order ID.

**Auth:** Required
**Errors:** 400, 401, 403, 404, 409, 5XX

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| venue_order_id | path | string (uuid) | yes | Unique identifier of the venue order |

**Response (200):** `{ data: Order }` -- note: `data` is a **single object**, not an array.

In addition to all `Order` fields, the response may include these optional fields (shown only when present):

| Field | Type | Description |
|-------|------|-------------|
| total_fee | string | Total fee charged for the order |
| fee_currency | string | Currency in which the fee was paid |

**Example response (limit order):**
```json
{
  "data": {
    "id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",
    "client_order_id": "984a4d8a-2a9b-4950-822f-2a40037f02bd",
    "symbol": "BTC/USD", "side": "buy", "type": "limit",
    "quantity": "0.002", "filled_quantity": "0", "leaves_quantity": "0.002",
    "price": "98745", "average_fill_price": "89794.51", "status": "new",
    "time_in_force": "gtc", "execution_instructions": ["allow_taker"],
    "created_date": 3318215482991, "updated_date": 3318215482991
  }
}
```

**Example response (tpsl order):**
```json
{
  "data": {
    "id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",
    "client_order_id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",
    "symbol": "BTC/USD", "side": "sell", "type": "tpsl",
    "quantity": "0.002", "filled_quantity": "0", "leaves_quantity": "0.002",
    "status": "new", "time_in_force": "gtc", "execution_instructions": [],
    "take_profit": {
      "trigger_price": "0.003", "type": "limit", "trigger_direction": "ge",
      "limit_price": "0.004", "time_in_force": "gtc", "execution_instructions": ["allow_taker"]
    },
    "stop_loss": {
      "trigger_price": "0.001", "type": "market", "trigger_direction": "le",
      "time_in_force": "ioc", "execution_instructions": ["allow_taker"]
    },
    "created_date": 1770197897742, "updated_date": 1770197897742
  }
}
```

**Example response (conditional order):**
```json
{
  "data": {
    "id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",
    "client_order_id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",
    "symbol": "BTC/USD", "side": "buy", "type": "conditional",
    "quantity": "0.003", "filled_quantity": "0", "leaves_quantity": "0.003",
    "amount": "1", "status": "new", "time_in_force": "gtc", "execution_instructions": [],
    "conditional": {
      "trigger_price": "0.002", "type": "limit", "trigger_direction": "le",
      "limit_price": "0.003", "time_in_force": "gtc", "execution_instructions": ["allow_taker"]
    },
    "created_date": 3318215482991, "updated_date": 3318215482991
  }
}
```

---

### DELETE /orders/{venue_order_id}

Cancel an active order by its venue order ID.

**Auth:** Required
**Errors:** 400, 401, 403, 404, 409, 5XX

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| venue_order_id | path | string (uuid) | yes | Unique identifier of the venue order |

**Response (204):** No content. Empty response body on success.

---

### Trades

---

### GET /orders/fills/{venue_order_id}

Get the fills (trade executions) for a specific order.

**Auth:** Required
**Errors:** 400, 401, 403, 404, 409, 5XX

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| venue_order_id | path | string (uuid) | yes | Unique identifier of the venue order |

**Response (200):** `{ data: [Trade] }` -- array of Trade objects, **no pagination metadata**.

**Example response:**
```json
{
  "data": [
    {
      "tdt": 3318215482991, "aid": "BTC", "anm": "Bitcoin",
      "p": "91686.16", "pc": "USD", "pn": "MONE",
      "q": "24.90000000", "qc": "BTC", "qn": "UNIT",
      "ve": "REVX", "pdt": 3318215482991, "vp": "REVX",
      "tid": "ad3e8787ab623ba5a1dfea53819be6f9"
    }
  ]
}
```

---

### GET /trades/all/{symbol}

Get all trades (market history) for a specific symbol, not limited to the authenticated user's own activity. Note: despite returning public market data, this endpoint requires authentication. For unauthenticated access to recent trades, use `GET /public/last-trades` instead.

**Auth:** Required
**Errors:** 400, 401, 403, 409, 5XX
**Pagination:** Yes (cursor-based)

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbol | path | string | yes | Trading pair symbol (e.g., `BTC-USD`) |
| start_date | query | integer (int64) | no | Start timestamp in Unix epoch ms. Defaults to `end_date - 1 week` |
| end_date | query | integer (int64) | no | End timestamp in Unix epoch ms. **Max range: 1 week** |
| cursor | query | string | no | Pagination cursor from previous response |
| limit | query | integer | no | Max records (1-100, default: 100) |

**Response (200):** `{ data: [Trade], metadata: { timestamp, next_cursor? } }`

**Example response:**
```json
{
  "data": [
    {
      "tdt": 3318215482991, "aid": "BTC", "anm": "Bitcoin",
      "p": "125056.76", "pc": "USD", "pn": "MONE",
      "q": "0.00003999", "qc": "BTC", "qn": "UNIT",
      "ve": "REVX", "pdt": 3318215482991, "vp": "REVX",
      "tid": "80654a036323311cb0ea28462b42db6d"
    }
  ],
  "metadata": {"timestamp": 3318215482991, "next_cursor": "GF0ZT0xNzY0OTMx..."}
}
```

---

### GET /trades/private/{symbol}

Get the authenticated user's own trade history (fills) for a specific symbol.

**Auth:** Required
**Errors:** 400, 401, 403, 409, 5XX
**Pagination:** Yes (cursor-based)

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbol | path | string | yes | Trading pair symbol (e.g., `BTC-USD`) |
| start_date | query | integer (int64) | no | Start timestamp in Unix epoch ms. Defaults to `end_date - 1 week` |
| end_date | query | integer (int64) | no | End timestamp in Unix epoch ms. **Max range: 1 week** |
| cursor | query | string | no | Pagination cursor from previous response |
| limit | query | integer | no | Max records (1-100, default: 100) |

**Response (200):** `{ data: [Trade], metadata: { timestamp, next_cursor? } }`

**Example response:** Same structure as `GET /trades/all/{symbol}`.

---

### Market Data

---

### GET /order-book/{symbol}

Get the current order book snapshot (bids and asks) for a specific trading pair.

**Auth:** Required
**Errors:** 400, 401, 403, 409, 5XX

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbol | path | string | yes | Trading pair symbol (e.g., `BTC-USD`) |
| limit | query | integer | no | Depth of order book (number of levels). Range: 1-20, default: 20 |

**Response (200):** `{ data: { asks: [OrderBookPriceLevel], bids: [OrderBookPriceLevel] }, metadata: { timestamp } }`

- `asks`: sell orders, sorted by price **descending**
- `bids`: buy orders, sorted by price **descending**
- `metadata.timestamp`: int64, Unix epoch milliseconds
- Note: all timestamps in this response (`pdt`, `metadata.timestamp`) are **int64 Unix epoch milliseconds**.

**Example response:**
```json
{
  "data": {
    "asks": [
      {"aid": "ETH", "anm": "Ethereum", "s": "SELL", "p": "4600", "pc": "USD", "pn": "MONE", "q": "17", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "3", "ts": "CLOB", "pdt": 3318215482991},
      {"aid": "ETH", "anm": "Ethereum", "s": "SELL", "p": "4555", "pc": "USD", "pn": "MONE", "q": "2.1234", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "2", "ts": "CLOB", "pdt": 3318215482991}
    ],
    "bids": [
      {"aid": "ETH", "anm": "Ethereum", "s": "BUYI", "p": "4550", "pc": "USD", "pn": "MONE", "q": "0.25", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "1", "ts": "CLOB", "pdt": 3318215482991},
      {"aid": "ETH", "anm": "Ethereum", "s": "BUYI", "p": "4500", "pc": "USD", "pn": "MONE", "q": "24.42", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "5", "ts": "CLOB", "pdt": 3318215482991}
    ]
  },
  "metadata": {"timestamp": 3318215482991}
}
```

---

### GET /candles/{symbol}

Get historical OHLCV (Open, High, Low, Close, Volume) candle data for a specific symbol. If there is trading volume, the view is based on recent trades. If there is no volume, the view is based on the mid price (bid/ask average).

**Auth:** Required
**Errors:** 400, 401, 403, 409, 5XX

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbol | path | string | yes | Trading pair symbol (e.g., `BTC-USD`) |
| interval | query | integer | no | Candle interval in minutes. Default: 5. See Appendix for allowed values |
| since | query | integer (int64) | no | Start timestamp in Unix epoch ms. Defaults to `until - (interval * 100)` |
| until | query | integer (int64) | no | End timestamp in Unix epoch ms. Defaults to now |

**Constraint:** `(until - since) / interval` must not exceed 100 candles.

**Response (200):** `{ data: [Candle] }`

**Example response:**
```json
{
  "data": [
    {"start": 3318215482991, "open": "92087.81", "high": "92133.89", "low": "92052.39", "close": "92067.31", "volume": "0.00067964"},
    {"start": 3318215782991, "open": "90390.46", "high": "90395", "low": "90358.84", "close": "90395", "volume": "0.00230816"}
  ]
}
```

---

### GET /tickers

Get the latest market data snapshots for all supported currency pairs, or filter by specific pairs.

**Auth:** Required
**Errors:** 400, 401, 403, 5XX

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbols | query | string (comma-separated) | no | Filter by currency pairs, e.g., `BTC-USD,ETH-USD`. If omitted, no filter is applied (returns all) |

**Response (200):** `{ data: [Ticker], metadata: { timestamp } }`

**Example response:**
```json
{
  "data": [
    {"symbol": "BTC/USD", "bid": "0.02", "ask": "0.02", "mid": "0.02", "last_price": "0.02"},
    {"symbol": "ETH/USD", "bid": "0.02", "ask": "0.02", "mid": "0.02", "last_price": "0.02"}
  ],
  "metadata": {"timestamp": 1770201294631}
}
```

---

### Public Market Data (No Authentication Required)

---

### GET /public/last-trades

Get the latest 100 trades executed on Revolut X. **No authentication required.**

**Auth:** Not required
**Rate limit:** 20 requests per 10 seconds
**Errors:** 5XX

**Parameters:** None

**Response (200):** `{ data: [PublicTrade], metadata: { timestamp } }`

Note: `PublicTrade` uses **ISO-8601 strings** for timestamps (`tdt`, `pdt`), unlike authenticated Trade objects which use int64 epoch milliseconds.

**Example response:**
```json
{
  "data": [
    {
      "tdt": "2025-08-08T21:40:35.133962Z", "aid": "BTC", "anm": "Bitcoin",
      "p": "116243.32", "pc": "USD", "pn": "MONE",
      "q": "0.24521000", "qc": "BTC", "qn": "UNIT",
      "ve": "REVX", "pdt": "2025-08-08T21:40:35.133962Z", "vp": "REVX",
      "tid": "5ef9648f658149f7ababedc97a6401f8"
    },
    {
      "tdt": "2025-08-08T21:40:34.132465Z", "aid": "ETH", "anm": "Ethereum",
      "p": "4028.23", "pc": "USDC", "pn": "MONE",
      "q": "12.00000000", "qc": "ETH", "qn": "UNIT",
      "ve": "REVX", "pdt": "2025-08-08T21:40:34.132465Z", "vp": "REVX",
      "tid": "3b2b202b766843cfa6c8b3354e7f4c52"
    }
  ],
  "metadata": {"timestamp": "2025-08-08T21:40:36.684333Z"}
}
```

---

### GET /public/order-book/{symbol}

Get the current order book (bids and asks) for a trading pair, with a maximum of 5 price levels. **No authentication required.**

**Auth:** Not required
**Rate limit:** 20 requests per 10 seconds
**Errors:** 5XX

**Parameters:**

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| symbol | path | string | yes | Trading pair symbol (e.g., `BTC-USD`) |

**Response (200):** `{ data: { asks: [OrderBookPublicPriceLevel], bids: [OrderBookPublicPriceLevel] }, metadata: { timestamp } }`

- Maximum 5 price levels per side
- `asks`: sell orders, sorted by price descending
- `bids`: buy orders, sorted by price descending
- `metadata.timestamp`: ISO-8601 string (not epoch ms)
- `OrderBookPublicPriceLevel.pdt`: ISO-8601 string (not epoch ms)
- **Important:** Unlike the authenticated `GET /order-book/{symbol}`, all timestamps here are ISO-8601 strings, not int64 epoch milliseconds.

**Example response:**
```json
{
  "data": {
    "asks": [
      {"aid": "ETH", "anm": "Ethereum", "s": "SELL", "p": "4600", "pc": "USD", "pn": "MONE", "q": "17", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "3", "ts": "CLOB", "pdt": "2025-08-08T21:40:36.124538Z"},
      {"aid": "ETH", "anm": "Ethereum", "s": "SELL", "p": "4555", "pc": "USD", "pn": "MONE", "q": "2.1234", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "2", "ts": "CLOB", "pdt": "2025-08-08T21:40:36.124538Z"}
    ],
    "bids": [
      {"aid": "ETH", "anm": "Ethereum", "s": "BUYI", "p": "4550", "pc": "USD", "pn": "MONE", "q": "0.25", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "1", "ts": "CLOB", "pdt": "2025-08-08T21:40:36.124538Z"},
      {"aid": "ETH", "anm": "Ethereum", "s": "BUYI", "p": "4500", "pc": "USD", "pn": "MONE", "q": "24.42", "qc": "ETH", "qn": "UNIT", "ve": "REVX", "no": "5", "ts": "CLOB", "pdt": "2025-08-08T21:40:36.124538Z"}
    ]
  },
  "metadata": {"timestamp": "2025-08-08T21:40:36.124538Z"}
}
```

---

## Data Type Reference

### AccountBalanceEntry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| currency | string | yes | Currency code (e.g., `BTC`, `USD`) |
| available | string (decimal) | yes | Available (free) funds |
| staked | string (decimal) | **no** | Staked funds earning rewards (optional, not always present) |
| reserved | string (decimal) | yes | Reserved (locked) funds |
| total | string (decimal) | yes | Available + reserved funds |

### Currency

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| symbol | string | yes | Currency symbol (e.g., `BTC`) |
| name | string | yes | Full name (e.g., `Bitcoin`) |
| scale | integer | yes | Number of decimal places (e.g., `8` for BTC = `0.00000001`) |
| asset_type | string | yes | `"fiat"` or `"crypto"` |
| status | string | yes | `"active"` or `"inactive"` |

### CurrencyPair

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| base | string | yes | Base currency (e.g., `BTC`) |
| quote | string | yes | Quote currency (e.g., `USD`) |
| base_step | string (decimal) | yes | Minimum quantity step in base currency |
| quote_step | string (decimal) | yes | Minimum amount step in quote currency |
| min_order_size | string (decimal) | yes | Minimum order quantity in base currency |
| max_order_size | string (decimal) | yes | Maximum order quantity in base currency |
| min_order_size_quote | string (decimal) | yes | Minimum order quantity in quote currency |
| status | string | yes | `"active"` or `"inactive"` |

### Order

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string (uuid) | yes | Order ID |
| previous_order_id | string (uuid) | no | ID of replaced order (only if this order replaced another) |
| client_order_id | string (uuid) | yes | Client-assigned order ID |
| symbol | string | yes | Trading pair (slash format, e.g., `BTC/USD`) |
| side | string | yes | `"buy"` or `"sell"` |
| type | string | yes | `"market"` \| `"limit"` \| `"conditional"` \| `"tpsl"` |
| quantity | string | yes | Order quantity in base currency. For sell orders, this is the exact initial locked balance to be sold. For buy orders, this is the estimated total quantity to be received upon completion (exact amount depends on final execution prices). |
| filled_quantity | string | yes | Exact quantity executed so far, in base currency. For buy orders: total base currency received (gross, before fees). For sell orders: total base currency spent. |
| leaves_quantity | string | yes | Remaining quantity not yet executed, in base currency. Represents the portion of `quantity` still waiting to be filled, or the portion that was cancelled. |
| amount | string | no | Order size in quote currency (shown only when present) |
| filled_amount | string | no | Quote-currency amount filled so far (shown only when present) |
| price | string | yes | Worst acceptable price for the order |
| average_fill_price | string | no | Quantity-weighted average execution price |
| status | string | yes | `"pending_new"` \| `"new"` \| `"partially_filled"` \| `"filled"` \| `"cancelled"` \| `"rejected"` \| `"replaced"` |
| reject_reason | string | no | Reason for rejection (only when `status=rejected`) |
| time_in_force | string | yes | `"gtc"` (good till cancelled) \| `"ioc"` (immediate or cancel) \| `"fok"` (fill or kill, no partial fills) |
| execution_instructions | array of string | yes | `["allow_taker"]` (default) \| `["post_only"]` \| `[]` (empty) |
| conditional | OrderTrigger | no | Trigger conditions (only when `type=conditional`) |
| take_profit | OrderTrigger | no | Take profit trigger (only when `type=tpsl`; at least one of `take_profit`/`stop_loss` present) |
| stop_loss | OrderTrigger | no | Stop loss trigger (only when `type=tpsl`; at least one of `take_profit`/`stop_loss` present) |
| created_date | integer (int64) | yes | Creation timestamp in Unix epoch milliseconds |
| updated_date | integer (int64) | yes | Last update timestamp in Unix epoch milliseconds |

### OrderTrigger

Used by `conditional`, `take_profit`, and `stop_loss` fields on `Order`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| trigger_price | string (decimal) | yes | Price level that activates the order |
| type | string | yes | `"market"` or `"limit"` |
| trigger_direction | string | yes | `"ge"` (greater/equal) or `"le"` (less/equal) |
| limit_price | string (decimal) | conditional | Execution price (required when `type=limit`) |
| time_in_force | string | yes | `"gtc"` or `"ioc"` only (no `"fok"`) |
| execution_instructions | array of string | yes | `["allow_taker"]` \| `["post_only"]` \| `[]` |

### Trade (Authenticated Endpoints)

Used by: `GET /orders/fills/{venue_order_id}`, `GET /trades/all/{symbol}`, `GET /trades/private/{symbol}`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tdt | integer (int64) | yes | Trade date/time in Unix epoch milliseconds |
| aid | string | yes | Crypto-asset ID code (e.g., `BTC`) |
| anm | string | yes | Crypto-asset full name (e.g., `Bitcoin`) |
| p | string | yes | Price in major currency units (e.g., `"116243.32"`) |
| pc | string | yes | Price currency (e.g., `USD`) |
| pn | string | yes | Price notation (always `"MONE"`) |
| q | string | yes | Quantity (e.g., `"0.24521000"`) |
| qc | string | yes | Quantity currency (e.g., `BTC`) |
| qn | string | yes | Quantity notation (always `"UNIT"`) |
| ve | string | yes | Venue of execution (always `"REVX"`) |
| pdt | integer (int64) | yes | Publication date/time in Unix epoch milliseconds |
| vp | string | yes | Venue of publication (always `"REVX"`) |
| tid | string | yes | Transaction identification code |

### PublicTrade (Public Endpoints)

Used by: `GET /public/last-trades`

**Same fields as Trade, but `tdt` and `pdt` are ISO-8601 strings** (e.g., `"2025-08-08T21:40:35.133962Z"`), not int64 epoch milliseconds.

### OrderBookPriceLevel (Authenticated)

Used by: `GET /order-book/{symbol}`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| aid | string | yes | Crypto-asset ID code |
| anm | string | yes | Crypto-asset full name |
| s | string | yes | Side: `"SELL"` or `"BUYI"` (note: **not** `"BUY"`) |
| p | string | yes | Price in major currency units |
| pc | string | yes | Price currency |
| pn | string | yes | Price notation (`"MONE"`) |
| q | string | yes | Aggregated quantity at this level |
| qc | string | yes | Quantity currency |
| qn | string | yes | Quantity notation (`"UNIT"`) |
| ve | string | yes | Venue (`"REVX"`) |
| no | string | yes | Number of orders at this price level |
| ts | string | yes | Trading system (`"CLOB"` = Central Limit Order Book) |
| pdt | integer (int64) | yes | Publication timestamp in Unix epoch milliseconds |

### OrderBookPublicPriceLevel (Public)

Used by: `GET /public/order-book/{symbol}`

**Same fields as OrderBookPriceLevel, but `pdt` is an ISO-8601 string** (e.g., `"2025-08-08T21:40:36.124538Z"`), not int64 epoch milliseconds.

### Candle

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| start | integer (int64) | yes | Candle start timestamp in Unix epoch milliseconds |
| open | string (decimal) | yes | Opening price |
| high | string (decimal) | yes | Highest price during interval |
| low | string (decimal) | yes | Lowest price during interval |
| close | string (decimal) | yes | Closing price |
| volume | string (decimal) | yes | Total trading volume during interval |

### Ticker

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| symbol | string | yes | Currency pair identifier (slash format, e.g., `BTC/USD`) |
| bid | string (decimal) | yes | Current highest buy price |
| ask | string (decimal) | yes | Current lowest sell price |
| mid | string (decimal) | yes | Midpoint: `(bid + ask) / 2` |
| last_price | string (decimal) | yes | Most recent trade price |

---

## Appendix: Candle Intervals

Allowed values for the `interval` query parameter on `GET /candles/{symbol}`:

| Minutes | Duration |
|---------|----------|
| 5 | 5 minutes |
| 15 | 15 minutes |
| 30 | 30 minutes |
| 60 | 1 hour |
| 240 | 4 hours |
| 1440 | 1 day |
| 2880 | 2 days |
| 5760 | 4 days |
| 10080 | 1 week |
| 20160 | 2 weeks |
| 40320 | 4 weeks |

**Constraint:** The total number of candles `(until - since) / interval` must not exceed 100.