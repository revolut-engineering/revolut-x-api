# API Tests

Comprehensive test suite for the Revolut X API client following Node.js best practices.

## Structure

Tests are organized by functionality for better maintainability:

```
tests/
├── helpers/
│   └── test-utils.ts           # Shared utilities, fixtures, and mock data
├── client/
│   ├── authentication.test.ts  # Authentication and authorization
│   ├── account.test.ts         # Account balance management
│   ├── configuration.test.ts   # Currencies and pairs configuration
│   ├── market-data.test.ts     # Tickers, candles, order books
│   ├── orders.test.ts          # Order placement and management
│   ├── trades.test.ts          # Trade history
│   └── error-handling.test.ts  # HTTP errors, retries, network issues
├── validation.test.ts          # Input validation with Zod
├── logger.test.ts              # Logging functionality
├── rate-limiter.test.ts        # Rate limiting
└── signer.test.ts              # Request signing

```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- client/orders.test.ts

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

## Test Utilities

### `createTestClient(options?)`

Factory function for creating test clients with configurable options:

```typescript
import { createTestClient } from "./helpers/test-utils.js";

// Authenticated client (default)
const client = createTestClient();

// Unauthenticated client
const unauthedClient = createTestClient({ authenticated: false });

// Custom retry/timeout
const customClient = createTestClient({
  maxRetries: 3,
  timeout: 5000,
});
```

### Mock Data

Pre-defined mock objects for consistent test data:

```typescript
import {
  mockBalance,
  mockCurrency,
  mockCurrencyPair,
  mockTicker,
  mockCandle,
  mockOrder,
  mockOrderBookLevel,
  mockTrade,
} from "./helpers/test-utils.js";
```

## Test Organization

### Client Tests

Each client test file focuses on a specific domain:

- **authentication.test.ts**: Authentication status, auth headers, 401 vs 403 errors, public endpoints
- **account.test.ts**: Balance retrieval, multiple currencies, decimal precision
- **configuration.test.ts**: Currency and pair configuration data
- **market-data.test.ts**: Market data retrieval (tickers, candles, order books)
- **orders.test.ts**: Order lifecycle (place, get, cancel, fills)
- **trades.test.ts**: Public and private trade history
- **error-handling.test.ts**: HTTP errors, retry logic, network failures

### Test Coverage

Each test file includes:

1. **Happy path tests**: Normal successful operations
2. **Edge cases**: Empty results, boundary conditions, multiple items
3. **Parameter variations**: Optional parameters, filters, pagination
4. **Data integrity**: Correct parsing, type preservation, decimal precision
5. **Error scenarios**: Various HTTP errors, validation failures

### Error Handling Tests

Comprehensive error testing includes:

- **HTTP status code errors**:
  - 401 (Unauthorized) → `AuthenticationError` - Invalid/missing credentials
  - 403 (Forbidden) → `ForbiddenError` - Valid credentials, insufficient permissions
  - 404 (Not Found) → `NotFoundError` - Resource doesn't exist
  - 400 (Bad Request) → `OrderError` - Invalid request parameters
  - 429 (Rate Limited) → `RateLimitError` - Too many requests
  - 409 (Conflict) → `ConflictError` - Request conflict
  - 500+ (Server Error) → `RevolutXError` - Server-side issues
- **Retry behavior** with exponential backoff
- **Retry-After header** respect for 429 errors
- **Network timeouts** and connection failures
- **Error cause preservation** (original error attached)
- **Non-retryable vs retryable errors**:
  - Non-retryable: 401, 403, 404, 400 (client errors)
  - Retryable: 429, 409, 500+ (server errors, rate limits)

## Best Practices

### Test Isolation

- Each test is independent and doesn't rely on others
- `nock.cleanAll()` runs after each test
- Network is disabled to prevent real API calls

### Descriptive Test Names

Tests use clear, descriptive names:

```typescript
it("respects Retry-After header on 429", async () => {
  // Test implementation
});
```

### Arrange-Act-Assert Pattern

Tests follow AAA pattern:

```typescript
it("returns array of account balances", async () => {
  // Arrange
  const client = createTestClient();
  nock(BASE_URL).get("/api/1.0/balances").reply(200, [mockBalance]);

  // Act
  const result = await client.getBalances();

  // Assert
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    currency: "BTC",
    available: "1.5",
  });
});
```

### Mock HTTP Requests

Using `nock` for HTTP mocking:

```typescript
// Simple mock
nock(BASE_URL).get("/api/1.0/balances").reply(200, []);

// With query parameters
nock(BASE_URL)
  .get("/api/1.0/orders/active")
  .query({ symbols: "BTC-USD" })
  .reply(200, { data: [] });

// With custom headers
nock(BASE_URL)
  .get("/api/1.0/balances")
  .reply(429, { message: "Rate limited" }, { "Retry-After": "1000" });

// Capture request body
let capturedBody: any;
nock(BASE_URL)
  .post("/api/1.0/orders", (body) => {
    capturedBody = body;
    return true;
  })
  .reply(200, { data: { id: "order-123" } });
```

## Adding New Tests

When adding functionality to the client:

1. **Choose the right file**: Add tests to the relevant domain file
2. **Use test utilities**: Leverage `createTestClient()` and mock data
3. **Cover edge cases**: Test both success and failure scenarios
4. **Test error handling**: Verify proper error types are thrown
5. **Document behavior**: Use descriptive test names and comments

Example structure:

```typescript
describe("NewFeature", () => {
  describe("mainMethod", () => {
    it("handles success case", async () => {
      // Test implementation
    });

    it("handles error case", async () => {
      // Test implementation
    });

    it("validates input parameters", async () => {
      // Test implementation
    });
  });
});
```

## CI/CD Integration

Tests are designed to run in CI/CD pipelines:

- No external dependencies or real API calls
- Deterministic and reproducible
- Fast execution (< 5 seconds for full suite)
- Clear error messages for debugging

## Debugging Tests

```bash
# Run single test with verbose output
npm test -- --reporter=verbose client/orders.test.ts

# Debug in VS Code
# Add breakpoint and use "JavaScript Debug Terminal"

# Check test coverage
npm run test:coverage
# Open coverage/index.html in browser
```
