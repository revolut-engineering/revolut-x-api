# Revolut X — Request & Response Schemas

## Order Placement Request

`POST /api/1.0/orders`

```json
{
  "client_order_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",  // UUID, required — for idempotency
  "symbol": "BTC-USD",                                          // required
  "side": "buy",                                                // "buy" | "sell", required
  "order_configuration": {                                      // required — exactly one of:
    "limit": {
      "price": "90000.10",        // required for limit
      "base_size": "0.1",         // one of base_size or quote_size
      "quote_size": "500.00",     // one of base_size or quote_size
      "execution_instructions": ["post_only"]  // [] | ["allow_taker"] | ["post_only"]
    },
    "market": {
      "base_size": "0.1",         // one of base_size or quote_size
      "quote_size": "500.00"      // one of base_size or quote_size
    }
  }
}
```

### Execution Instructions
- `allow_taker` — default; order can execute as a taker
- `post_only` — order cancelled if it would execute immediately (maker only)
- Pass `[]` for no instructions

### Order Placement Response
```json
{
  "data": {
    "venue_order_id": "7a52e92e-8639-4fe1-abaa-68d3a2d5234b",  // system-assigned UUID
    "client_order_id": "984a4d8a-2a9b-4950-822f-2a40037f02bd",
    "state": "new"   // pending_new | new | partially_filled | filled | cancelled | rejected | replaced
  }
}
```

---

## Order Object (full)

Returned by GET `/orders/active`, `/orders/historical`, `/orders/{venue_order_id}`:

| Field | Type | Description |
|---|---|---|
| `id` | uuid | System order ID (`venue_order_id`) |
| `client_order_id` | uuid | Client-assigned ID |
| `previous_order_id` | uuid | Set if this order replaced another |
| `symbol` | string | Trading pair (e.g. `BTC-USD`) |
| `side` | string | `buy` \| `sell` |
| `type` | string | `market` \| `limit` \| `conditional` \| `tpsl` |
| `quantity` | decimal string | Order size in base currency (sell: initial locked amount) |
| `filled_quantity` | decimal string | Amount executed so far |
| `leaves_quantity` | decimal string | Amount remaining to fill |
| `amount` | decimal string | Order size in quote currency (buy: initial locked amount) |
| `price` | decimal string | Worst acceptable price (max for buy, min for sell) |
| `average_fill_price` | decimal string | Quantity-weighted average execution price |
| `status` | string | See order statuses below |
| `reject_reason` | string | Present only when `status=rejected` |
| `time_in_force` | string | `gtc` \| `ioc` \| `fok` |
| `execution_instructions` | array | `allow_taker` and/or `post_only` |
| `conditional` | object | Present only for `type=conditional` — see OrderTrigger |
| `take_profit` | object | Present for `type=tpsl` — see OrderTrigger |
| `stop_loss` | object | Present for `type=tpsl` — see OrderTrigger |
| `created_date` | int64 | Unix epoch milliseconds |
| `updated_date` | int64 | Unix epoch milliseconds |

### Order Statuses
- `pending_new` — accepted by matching engine, not yet working
- `new` — working order
- `partially_filled` — partially executed
- `filled` — fully executed
- `cancelled` — cancelled
- `rejected` — rejected (check `reject_reason`)
- `replaced` — replaced by another order

### Time In Force
- `gtc` — Good till cancelled: stays active until filled or manually cancelled
- `ioc` — Immediate or cancel: unfilled portion cancelled immediately
- `fok` — Fill or kill: must fill entirely immediately or be cancelled (no partial fills)

### OrderTrigger (for conditional / TPSL)
| Field | Type | Description |
|---|---|---|
| `trigger_price` | decimal string | Price level that activates the order |
| `type` | string | `market` \| `limit` |
| `trigger_direction` | string | `ge` (≥ trigger) \| `le` (≤ trigger) |
| `limit_price` | decimal string | Execution price — required for limit triggers |
| `time_in_force` | string | `gtc` \| `ioc` |
| `execution_instructions` | array | `allow_taker` and/or `post_only` |

---

## Account Balance

`GET /api/1.0/balances` — returns an array:

| Field | Type | Description |
|---|---|---|
| `currency` | string | Currency symbol (e.g. `BTC`) |
| `available` | decimal string | Free funds |
| `reserved` | decimal string | Locked funds (open orders) |
| `staked` | decimal string | Funds earning staking rewards (if applicable) |
| `total` | decimal string | Sum of available + reserved + staked |

---

## Currency

`GET /api/1.0/configuration/currencies` — returns a map keyed by symbol:

| Field | Type | Description |
|---|---|---|
| `symbol` | string | e.g. `BTC` |
| `name` | string | e.g. `Bitcoin` |
| `scale` | integer | Decimal places (e.g. `8` means precision to 0.00000001) |
| `asset_type` | string | `fiat` \| `crypto` |
| `status` | string | `active` \| `inactive` |

---

## Currency Pair

`GET /api/1.0/configuration/pairs` — returns a map keyed by pair (e.g. `BTC/USD`):

| Field | Type | Description |
|---|---|---|
| `base` | string | Base currency |
| `quote` | string | Quote currency |
| `base_step` | decimal string | Min increment for base currency quantity |
| `quote_step` | decimal string | Min increment for quote currency amount |
| `min_order_size` | decimal string | Min order quantity in base currency |
| `max_order_size` | decimal string | Max order quantity in base currency |
| `min_order_size_quote` | decimal string | Min order quantity in quote currency |
| `status` | string | `active` \| `inactive` |

---

## Ticker

`GET /api/1.0/tickers` — returns `data` array + `metadata.timestamp`:

| Field | Type | Description |
|---|---|---|
| `symbol` | string | e.g. `BTC/USD` |
| `bid` | decimal string | Best buy price (top of buy book) |
| `ask` | decimal string | Best sell price (top of sell book) |
| `mid` | decimal string | `(bid + ask) / 2` |
| `last_price` | decimal string | Price of the most recent trade |

---

## Candle (OHLCV)

`GET /api/1.0/candles/{symbol}` — returns array of candle objects:

| Field | Type | Description |
|---|---|---|
| `start` | int64 | Candle start time, Unix epoch milliseconds |
| `open` | decimal string | Opening price |
| `high` | decimal string | Highest price in interval |
| `low` | decimal string | Lowest price in interval |
| `close` | decimal string | Closing price |
| `volume` | decimal string | Total trading volume |

**Query parameters:**
- `interval` (int, minutes): `1`, `5`, `15`, `30`, `60`, `240`, `1440`, `2880`, `5760`, `10080`, `20160`, `40320` — default `5`
- `since` (int64, ms): start of range — defaults to `until - (interval * 100)`
- `until` (int64, ms): end of range — defaults to current time
- Max candles per request: `(until - since) / interval ≤ 1000`

If no trades in a period, candle is based on mid price (bid/ask average).

---

## Order Book

`GET /api/1.0/order-book/{symbol}` (auth) — up to 20 levels
`GET /api/1.0/public/order-book/{symbol}` (no auth) — max 5 levels

Response structure: `data.asks[]` and `data.bids[]` — both sorted by price descending, plus `metadata.timestamp`.

### Client-normalized format (authenticated `getOrderBook`)

Each price level returned by the client:

| Field | Type | Description |
|---|---|---|
| `price` | decimal string | Price at this level |
| `quantity` | decimal string | Aggregated quantity at this level |
| `orderCount` | number | Number of orders at this level |

### Raw wire format (public endpoint / direct API access)

Each price level in the raw API response:

| Field | Description |
|---|---|
| `aid` | Asset ID (e.g. `ETH`) |
| `anm` | Asset full name |
| `p` | Price |
| `pc` | Price currency |
| `pn` | Price name |
| `q` | Aggregated quantity at this level |
| `qc` | Quantity currency |
| `qn` | Quantity name |
| `no` | Number of orders at this level |
| `s` | Side: `SELL` \| `BUYI` |
| `ve` | Venue — always `REVX` |
| `ts` | Trading system — always `CLOB` |
| `pdt` | Publication timestamp |

---

## Trade Fields

### Client-normalized format

`getAllTrades` returns `PublicTrade[]`, `getPrivateTrades` and `getOrderFills` return `Trade[]`.

**`PublicTrade`** (returned by `getAllTrades`):

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Trade ID (converted from hex `tid`) |
| `symbol` | string | Trading pair in `BASE/QUOTE` format (e.g. `BTC/USD`) |
| `price` | decimal string | Execution price |
| `quantity` | decimal string | Execution quantity |
| `timestamp` | int64 | Trade timestamp in Unix epoch milliseconds |

**`Trade`** (returned by `getPrivateTrades` and `getOrderFills`):

All `PublicTrade` fields plus:

| Field | Type | Description |
|---|---|---|
| `side` | string | `buy` \| `sell` |
| `orderId` | string (UUID) | Associated order ID (converted from hex `oid`) |
| `maker` | boolean | `true` = maker, `false` = taker |

> **Note:** The `symbol` field in trade objects uses `BASE/QUOTE` format with a slash (e.g. `BTC/USD`), not the `BASE-QUOTE` dash format used for order placement parameters.

### Raw wire format (direct API access)

Both public and private trades use abbreviated field names in the raw response:

| Field | Description |
|---|---|
| `tdt` | Trade timestamp (Unix epoch milliseconds) |
| `aid` | Asset ID (e.g. `BTC`) |
| `anm` | Asset full name |
| `p` | Price |
| `pc` | Price currency |
| `pn` | Price name |
| `q` | Quantity |
| `qc` | Quantity currency |
| `qn` | Quantity name |
| `tid` | Transaction ID (hex) |
| `ve` | Venue — always `REVX` |
| `vp` | Venue of publication — always `REVX` |
| `pdt` | Publication timestamp |

Private trades additionally include:

| Field | Description |
|---|---|
| `oid` | Order ID (hex, maps to UUID `orderId`) |
| `s` | Trade direction: `buy` \| `sell` |
| `im` | `true` = maker, `false` = taker |

---

## Query Parameters — Date Ranges

Used by `/orders/historical`, `/trades/all/{symbol}`, `/trades/private/{symbol}`:

- `start_date` — Unix epoch ms. Defaults to `end_date - 7 days`
- `end_date` — Unix epoch ms. Defaults to `start_date + 7 days` or current time
- **Max range: 30 days** — difference between `start_date` and `end_date` must not exceed 30 days

---

## Active Orders — Query Filters

`GET /api/1.0/orders/active`:

| Param | Values | Description |
|---|---|---|
| `symbols` | comma-separated | e.g. `BTC-USD,ETH-USD` |
| `order_states` | `pending_new`, `new`, `partially_filled` | |
| `order_types` | `limit`, `conditional`, `tpsl` | |
| `side` | `buy`, `sell` | |
| `cursor` | string | Pagination cursor from `metadata.next_cursor` |
| `limit` | 1–100 | Default 100 |

---

## Historical Orders — Query Filters

`GET /api/1.0/orders/historical`:

| Param | Values | Description |
|---|---|---|
| `symbols` | comma-separated | e.g. `BTC-USD,ETH-USD` |
| `order_states` | `filled`, `cancelled`, `rejected`, `replaced` | |
| `order_types` | `market`, `limit` | |
| `start_date` / `end_date` | int64 ms | Max 30-day range |
| `cursor` | string | Pagination cursor |
| `limit` | 1–100 | Default 100 |

---

## Error Response

All errors return:

```json
{
  "error_id": "7d85b5e7-d0f0-4696-b7b5-a300d0d03a5e",
  "message": "Human-readable description",
  "timestamp": 3318215482991
}
```

| HTTP Status | Meaning |
|---|---|
| `400` | Bad request (e.g. invalid symbol) |
| `401` | Unauthorized (invalid/missing API key or signature) |
| `403` | Forbidden (e.g. IP not whitelisted) |
| `404` | Order not found |
| `409` | Conflict (e.g. timestamp in the future) |
| `429` | Rate limit exceeded — check `Retry-After` header (milliseconds) |
| `5XX` | Server error |
