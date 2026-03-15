# revolutx-api

Typed HTTP client for the [Revolut X Exchange](https://revx.revolut.com) REST API. Zero runtime dependencies — uses only Node.js built-ins (`crypto`, `fetch`).

## Installation

Download `revolutx-api-*.tgz` from the [latest release](https://github.com/revolut-engineering/revolut-x-api/releases/latest), then:

```bash
npm install ./revolutx-api-*.tgz
```

Or from source:

```bash
git clone https://github.com/revolut-engineering/revolut-x-api.git && cd revolut-x-api/api
npm install && npm run build
```

Requires Node.js 20+.

## Quick Start

```typescript
import { RevolutXClient } from "revolutx-api";

const client = new RevolutXClient({
  apiKey: "your-api-key",
  privateKeyPath: "~/.config/revolut-x/private.pem",
});

const balances = await client.getBalances();
console.log(balances);
```

## Configuration

### Client Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | — | Revolut X API key |
| `privateKey` | `KeyObject` | — | Ed25519 private key object |
| `privateKeyPath` | `string` | — | Path to PEM-encoded private key file |
| `baseUrl` | `string` | `https://revx.revolut.com` | API base URL |
| `timeout` | `number` | `30000` | Request timeout in milliseconds |
| `maxRetries` | `number` | `3` | Max retry attempts for failed requests |
| `autoLoadCredentials` | `boolean` | `true` | Auto-load credentials from config directory |

### Credential Auto-loading

When neither `apiKey` nor `privateKey` is provided, the client loads credentials from the platform config directory:

| Platform | Path |
|----------|------|
| macOS | `~/.config/revolut-x/` |
| Linux | `~/.config/revolut-x/` |
| Windows | `%APPDATA%\revolut-x\` |

Override with `REVOLUTX_CONFIG_DIR` environment variable.

Expected files: `config.json` (contains `apiKey`) and `private.pem` (Ed25519 key).

Set `autoLoadCredentials: false` to disable.

## API Reference

### Account

```typescript
// Get all balances
const balances = await client.getBalances();
// → AccountBalance[] — { currency, available, reserved, total, staked? }
```

### Configuration

```typescript
// Get supported currencies
const currencies = await client.getCurrencies();
// → CurrencyMap — { [symbol]: { symbol, name, scale, asset_type, status } }

// Get trading pairs
const pairs = await client.getCurrencyPairs();
// → CurrencyPairMap — { [pair]: { base, quote, base_step, quote_step, min/max_order_size, status } }
```

### Market Data

```typescript
// Tickers (all or filtered)
const tickers = await client.getTickers();
const btc = await client.getTickers({ symbols: ["BTC-USD"] });
// → { data: Ticker[], metadata: { timestamp } }

// OHLCV candles
const candles = await client.getCandles("BTC-USD", {
  interval: 60,        // minutes (or "1h", "4h", "1d", etc.)
  startDate: 1700000000000,
  endDate: 1700086400000,
});
// → { data: Candle[] }

// Order book (authenticated)
const book = await client.getOrderBook("BTC-USD", { limit: 10 });
// → { data: { asks, bids }, metadata: { timestamp } }
```
### Orders

```typescript
// Place limit buy
const result = await client.placeOrder({
  symbol: "BTC-USD",
  side: "buy",
  limit: { price: "95000", baseSize: "0.001" },
});
// → { data: { venue_order_id, client_order_id, state } }

// Place market sell
await client.placeOrder({
  symbol: "BTC-USD",
  side: "sell",
  market: { baseSize: "0.001" },
});

// Active orders (with filters)
const active = await client.getActiveOrders({
  symbols: ["BTC-USD"],
  side: "buy",
  limit: 50,
});

// Historical orders
const history = await client.getHistoricalOrders({
  startDate: 1700000000000,
  endDate: 1700086400000,
});

// Get specific order
const order = await client.getOrder("venue-order-id");

// Cancel single order
await client.cancelOrder("venue-order-id");

// Cancel all active orders
await client.cancelAllOrders();
```

### Trades

```typescript
// Order fills
const fills = await client.getOrderFills("venue-order-id");

// All trades for a pair
const trades = await client.getAllTrades("BTC-USD", {
  startDate: 1700000000000,
  endDate: 1700086400000,
});

// My private trades
const myTrades = await client.getPrivateTrades("BTC-USD");
```

## Authentication

Revolut X uses Ed25519 request signing. Each request includes three headers:

- `X-Revx-API-Key` — your API key
- `X-Revx-Timestamp` — epoch milliseconds
- `X-Revx-Signature` — Ed25519 signature of `{timestamp}{METHOD}{path}{query}{body}`

### Generating a Keypair

```typescript
import { generateKeypair } from "revolutx-api";

const { publicKeyPem } = generateKeypair("/path/to/output/dir");
console.log("Register this public key with Revolut X:");
console.log(publicKeyPem);
```

### Auth Utilities

```typescript
import { signRequest, buildAuthHeaders, loadPrivateKey } from "revolutx-api";

const key = loadPrivateKey("/path/to/private.pem");
const headers = buildAuthHeaders("api-key", key, "GET", "/api/1.0/balances");
```

## Error Handling

All errors extend `RevolutXError`:

| Error | HTTP Status | When |
|-------|-------------|------|
| `AuthNotConfiguredError` | — | No API key or private key configured |
| `AuthenticationError` | 401 | Invalid API key or signature |
| `ForbiddenError` | 403 | Access denied |
| `RateLimitError` | 429 | Rate limit exceeded — check `retryAfter` (ms) |
| `ValidationError` | 400 | Request failed schema validation |
| `OrderError` | 400 | Invalid order parameters |
| `NotFoundError` | 404 | Resource not found |
| `ConflictError` | 409 | Conflicting request (e.g. timestamp skew) |
| `ServerError` | 5xx | Server-side error — check `statusCode` |
| `NetworkError` | — | Connection or timeout failure |

```typescript
import { RateLimitError, OrderError } from "revolutx-api";

try {
  await client.placeOrder({ ... });
} catch (err) {
  if (err instanceof RateLimitError) {
    const waitMs = err.retryAfter ?? 1000;
    console.log(`Rate limited. Retry after ${waitMs}ms`);
  } else if (err instanceof OrderError) {
    console.error("Order rejected:", err.message);
  }
}
```

## Rate Limiting

The client does not throttle requests proactively. When the server responds with `429`, a `RateLimitError` is thrown immediately. Check the `retryAfter` property for the server-indicated wait time in milliseconds before retrying.

## Symbol Format

Use **dashes** in requests: `BTC-USD`, `ETH-USD`.

The API returns symbols with **slashes** in responses: `BTC/USD`.

## Support

- **Issues:** [GitHub Issues](https://github.com/revolut-engineering/revolut-x-api/issues)
- **Revolut X API Docs:** [developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api](https://developer.revolut.com/docs/x-api/revolut-x-crypto-exchange-rest-api)

## License

MIT
