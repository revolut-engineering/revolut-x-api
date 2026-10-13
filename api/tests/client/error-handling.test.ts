import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { createTestClient, BASE_URL } from "../helpers/test-utils.js";
import {
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  BadRequestError,
  RateLimitError,
  ServerError,
  ConflictError,
  NetworkError,
} from "../../src/http/errors.js";
import { toNetworkError } from "../../src/http/request.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Error Handling", () => {
  describe("HTTP status errors", () => {
    it("throws AuthenticationError on 401 (unauthenticated)", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Invalid API key" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as Error).message).toContain("Invalid API key");
      }
    });

    it("throws AuthenticationError for missing credentials", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Missing authentication headers" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).statusCode).toBe(401);
        expect((err as Error).message).toContain("Missing authentication");
      }
    });

    it("throws AuthenticationError for expired credentials", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Signature expired" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as Error).message).toContain("Signature expired");
      }
    });

    it("throws ForbiddenError on 403 (unauthorized/no permission)", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(403, { message: "Access denied" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as Error).message).toContain("Access denied");
      }
    });

    it("throws ForbiddenError for insufficient permissions", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(403, { message: "Trading not enabled for this API key" });

      try {
        await client.placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          limit: { price: "95000", baseSize: "0.001" },
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).statusCode).toBe(403);
        expect((err as Error).message).toContain("Trading not enabled");
      }
    });

    it("throws ForbiddenError for resource access restriction", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/orders/restricted-order-id").reply(403, {
        message: "You don't have permission to view this order",
      });

      try {
        await client.getOrder("restricted-order-id");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as Error).message).toContain("don't have permission");
      }
    });

    it("distinguishes between 401 and 403 errors", async () => {
      const client = createTestClient();

      // Test 401
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Unauthorized" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect(err).not.toBeInstanceOf(ForbiddenError);
      }

      // Test 403
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(403, { message: "Forbidden" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err).not.toBeInstanceOf(AuthenticationError);
      }
    });

    it("throws NotFoundError on 404", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/nonexistent")
        .reply(404, { message: "Order not found" });

      try {
        await client.getOrder("nonexistent");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as Error).message).toContain("Order not found");
      }
    });

    it("throws OrderError on 400", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(400, { message: "Insufficient funds" });

      await expect(
        client.placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          limit: { price: "95000", baseSize: "999" },
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it("throws RateLimitError on 429", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(429, { message: "Rate limit exceeded" });

      await expect(client.getBalances()).rejects.toThrow(RateLimitError);
    });

    it("includes error message from response body", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(400, { message: "Insufficient funds" });

      await expect(
        client.placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          limit: { price: "95000", baseSize: "999" },
        }),
      ).rejects.toThrow("Insufficient funds");
    });
  });

  describe("Retry-After header", () => {
    it("extracts Retry-After value from 429 response", async () => {
      const client = createTestClient({ maxRetries: 0 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(429, { message: "Rate limited" }, { "Retry-After": "5000" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown RateLimitError");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfter).toBe(5000);
      }
    });

    it("handles missing Retry-After header", async () => {
      const client = createTestClient({ maxRetries: 0 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(429, { message: "Rate limited" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown RateLimitError");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfter).toBeUndefined();
      }
    });
  });

  describe("Non-retryable errors", () => {
    it("does not retry on 401 authentication errors", async () => {
      const client = createTestClient({ maxRetries: 3 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Invalid credentials" });

      const start = Date.now();
      await expect(client.getBalances()).rejects.toThrow(AuthenticationError);
      const elapsed = Date.now() - start;

      // Should fail immediately without retries
      expect(elapsed).toBeLessThan(100);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("does not retry on 403 forbidden errors", async () => {
      const client = createTestClient({ maxRetries: 3 });
      nock(BASE_URL)
        .delete("/api/1.0/orders/order-123")
        .reply(403, { message: "Cannot cancel other user's orders" });

      const start = Date.now();
      await expect(client.cancelOrder("order-123")).rejects.toThrow(
        ForbiddenError,
      );
      const elapsed = Date.now() - start;

      // Should fail immediately without retries
      expect(elapsed).toBeLessThan(100);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("does not retry on 404 not found errors", async () => {
      const client = createTestClient({ maxRetries: 3 });
      nock(BASE_URL)
        .get("/api/1.0/orders/missing")
        .reply(404, { message: "Not found" });

      const start = Date.now();
      await expect(client.getOrder("missing")).rejects.toThrow(NotFoundError);
      const elapsed = Date.now() - start;

      // Should fail immediately without retries
      expect(elapsed).toBeLessThan(100);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("does not retry on 400 client errors", async () => {
      const client = createTestClient({ maxRetries: 3 });
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(400, { message: "Bad request" });

      const start = Date.now();
      await expect(
        client.placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          limit: { price: "95000", baseSize: "0.001" },
        }),
      ).rejects.toThrow(BadRequestError);
      const elapsed = Date.now() - start;

      // Should fail immediately without retries
      expect(elapsed).toBeLessThan(100);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("does not retry on 409 conflict errors", async () => {
      const client = createTestClient({ maxRetries: 3 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(409, { message: "Request timestamp is in the future" });

      const start = Date.now();
      await expect(client.getBalances()).rejects.toThrow(ConflictError);
      const elapsed = Date.now() - start;

      // Should fail immediately without retries
      expect(elapsed).toBeLessThan(100);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("treats both 401 and 403 as non-retryable", async () => {
      const client = createTestClient({ maxRetries: 2 });

      // 401 should not retry
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Unauthorized" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
      }

      // 403 should not retry
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(403, { message: "Forbidden" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
      }

      // Both should have only made one request (no retries)
      expect(nock.pendingMocks()).toHaveLength(0);
    });
  });

  describe("Retry behavior", () => {
    it("throws immediately on 429 without retry", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(429, { message: "Rate limit exceeded" });

      await expect(client.getBalances()).rejects.toThrow(RateLimitError);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("throws ConflictError immediately on 409 without retry", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(409, { message: "Request timestamp is in the future" });

      await expect(client.getBalances()).rejects.toThrow(ConflictError);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("throws ServerError on 5xx responses", async () => {
      const client = createTestClient({ maxRetries: 0 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(503, { message: "Service unavailable" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown ServerError");
      } catch (err) {
        expect(err).toBeInstanceOf(ServerError);
        expect((err as ServerError).statusCode).toBe(503);
        expect((err as ServerError).message).toBe("Service unavailable");
      }
    });

    it("retries on 500+ server errors", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(500, { message: "Internal server error" });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(200, [
          { currency: "BTC", available: "1.0", reserved: "0", total: "1.0" },
        ]);

      const result = await client.getBalances();

      expect(result).toHaveLength(1);
    });

    it("exhausts retries and throws ServerError", async () => {
      const client = createTestClient({ maxRetries: 2 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .times(3)
        .reply(500, { message: "Server error" });

      await expect(client.getBalances()).rejects.toBeInstanceOf(ServerError);
    });

    it("uses exponential backoff for retries without Retry-After", async () => {
      const client = createTestClient({ maxRetries: 2 });
      const delays: number[] = [];
      let lastTime = Date.now();
      let isFirstCall = true;

      nock(BASE_URL)
        .get("/api/1.0/balances")
        .times(2)
        .reply(() => {
          const now = Date.now();
          if (!isFirstCall) {
            delays.push(now - lastTime);
          }
          lastTime = now;
          isFirstCall = false;
          return [500, { message: "Error" }];
        });

      nock(BASE_URL).get("/api/1.0/balances").reply(200, []);

      await client.getBalances();

      expect(delays.length).toBeGreaterThan(0);
      expect(delays[0]).toBeGreaterThan(400);
    });
  });

  describe("Network errors", () => {
    function failure(code: string, message = code): Error {
      return Object.assign(new Error(message), { code });
    }

    it("throws network errors immediately without retry", async () => {
      const client = createTestClient({ maxRetries: 1, timeout: 100 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .replyWithError(new TypeError("fetch failed"));

      const error = await client.getBalances().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).cause).toBeInstanceOf(TypeError);
      expect(nock.pendingMocks()).toHaveLength(0);
    });

    it("says a reply lost after sending may have reached the exchange", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .replyWithError(failure("UND_ERR_SOCKET", "other side closed"));

      const error = await client
        .placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          clientOrderId: "c-1",
          limit: { price: "90000", baseSize: "0.001" },
        })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).message).toBe(
        "No reply from the exchange: UND_ERR_SOCKET.",
      );
      expect((error as NetworkError).mayHaveReachedServer).toBe(true);
    });

    it.each(["ECONNREFUSED", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"])(
      "says a request that failed with %s never reached the exchange",
      async (code) => {
        const client = createTestClient();
        nock(BASE_URL).get("/api/1.0/balances").replyWithError(failure(code));

        const error = await client.getBalances().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toBe(
          `Could not reach the exchange: ${code}.`,
        );
        expect((error as NetworkError).mayHaveReachedServer).toBe(false);
      },
    );

    it("reads the code undici puts on the cause of a fetch failure", () => {
      const error = toNetworkError(
        new TypeError("fetch failed", { cause: failure("ECONNREFUSED") }),
        30_000,
      );

      expect(error?.message).toBe(
        "Could not reach the exchange: ECONNREFUSED.",
      );
      expect(error?.mayHaveReachedServer).toBe(false);
    });

    it("keeps the server error in view when the retry after it times out", () => {
      const error = toNetworkError(
        new DOMException("The operation timed out.", "TimeoutError"),
        30_000,
        true,
      );

      expect(error?.message).toBe(
        "The exchange answered with a server error, and the retry got no reply within 30 s.",
      );
      expect(error?.mayHaveReachedServer).toBe(true);
    });

    it("treats a timeout as a reply that may have been lost", () => {
      const error = toNetworkError(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
        30_000,
      );

      expect(error?.message).toBe("No reply from the exchange within 30 s.");
      expect(error?.mayHaveReachedServer).toBe(true);
    });

    it("leaves errors that are not network failures alone", () => {
      expect(
        toNetworkError(new SyntaxError("Unexpected token"), 30_000),
      ).toBeNull();
      expect(toNetworkError(new TypeError("Invalid URL"), 30_000)).toBeNull();
      expect(
        toNetworkError(new ServerError("Server error", 500), 30_000),
      ).toBeNull();
    });

    it.each([
      ["a TLS handshake failure", failure("ERR_SSL_WRONG_VERSION_NUMBER")],
      ["an invalid address", failure("ERR_INVALID_URL")],
      [
        "a blocked port",
        new TypeError("fetch failed", { cause: new Error("bad port") }),
      ],
      [
        "a host unreachable while connecting",
        new TypeError("fetch failed", {
          cause: Object.assign(failure("EHOSTUNREACH"), { syscall: "connect" }),
        }),
      ],
      [
        "an unreachable network on every address",
        new TypeError("fetch failed", {
          cause: Object.assign(
            new AggregateError([
              Object.assign(failure("ENETUNREACH"), { syscall: "connect" }),
              Object.assign(failure("ENETUNREACH"), { syscall: "connect" }),
            ]),
            { code: "ENETUNREACH" },
          ),
        }),
      ],
    ])("says %s never reached the exchange", (_name, error) => {
      expect(toNetworkError(error, 30_000)?.mayHaveReachedServer).toBe(false);
    });

    it.each([
      [
        "a TLS record error on an open connection",
        failure("ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"),
      ],
      [
        "a host unreachable after connecting",
        new TypeError("fetch failed", {
          cause: Object.assign(failure("EHOSTUNREACH"), { syscall: "read" }),
        }),
      ],
      ["a host unreachable with no step named", failure("ENETDOWN")],
      [
        "an unreachable network on only some addresses",
        new TypeError("fetch failed", {
          cause: Object.assign(
            new AggregateError([
              Object.assign(failure("ENETUNREACH"), { syscall: "connect" }),
              Object.assign(failure("ENETUNREACH"), { syscall: "write" }),
            ]),
            { code: "ENETUNREACH" },
          ),
        }),
      ],
      [
        "an unreachable network with no inner errors",
        new TypeError("fetch failed", {
          cause: Object.assign(new AggregateError([]), { code: "ENETUNREACH" }),
        }),
      ],
    ])("says %s may have reached the exchange", (_name, error) => {
      expect(toNetworkError(error, 30_000)?.mayHaveReachedServer).toBe(true);
    });

    it("sets no cause on a network error built without one", () => {
      const error = new NetworkError("No reply from the exchange.");

      expect(error.cause).toBeUndefined();
      expect("cause" in error).toBe(false);
    });

    function placeOrder(client: ReturnType<typeof createTestClient>) {
      return client
        .placeOrder({
          symbol: "BTC-USD",
          side: "buy",
          clientOrderId: "c-1",
          limit: { price: "90000", baseSize: "0.001" },
        })
        .catch((err: unknown) => err);
    }

    it("keeps an order uncertain when the retry after a server error can't connect", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(503, { message: "Unavailable" })
        .post("/api/1.0/orders")
        .replyWithError(failure("ECONNREFUSED"));

      const error = await placeOrder(client);

      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).mayHaveReachedServer).toBe(true);
      expect((error as NetworkError).message).toBe(
        "The exchange answered with a server error, and the retry failed: ECONNREFUSED.",
      );
    });

    it("keeps an order uncertain when the retry after a server error is refused", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(503, { message: "Unavailable" })
        .post("/api/1.0/orders")
        .reply(429, { message: "Too many requests" });

      const error = await placeOrder(client);

      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).cause).toBeInstanceOf(RateLimitError);
    });

    it("passes on the duplicate-id answer to a retry after a server error", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(503, { message: "Unavailable" })
        .post("/api/1.0/orders")
        .reply(400, {
          message:
            "An order with the client_order_id 'c-1' has already been placed",
        });

      const error = await placeOrder(client);

      expect(error).toBeInstanceOf(BadRequestError);
      expect((error as BadRequestError).cause).toBeInstanceOf(ServerError);
    });

    it("passes on a duplicate-id answer with no server error before it without a cause", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL).post("/api/1.0/orders").reply(400, {
        message:
          "An order with the client_order_id 'c-1' has already been placed",
      });

      const error = await placeOrder(client);

      expect(error).toBeInstanceOf(BadRequestError);
      expect((error as BadRequestError).cause).toBeUndefined();
    });

    it("keeps a cancel uncertain when the retry after a server error finds no order", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .delete("/api/1.0/orders/o-1")
        .reply(503, { message: "Unavailable" })
        .delete("/api/1.0/orders/o-1")
        .reply(404, { message: "Order not found" });

      const error = await client
        .cancelOrder("o-1")
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).cause).toBeInstanceOf(NotFoundError);
    });

    it("keeps a replace uncertain when the retry after a server error finds no order", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .put("/api/1.0/orders/o-1")
        .reply(503, { message: "Unavailable" })
        .put("/api/1.0/orders/o-1")
        .reply(404, { message: "Order not found" });

      const error = await client
        .replaceOrder("o-1", { clientOrderId: "c-2", price: "91000" })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).cause).toBeInstanceOf(NotFoundError);
    });

    it("leaves a read that failed after a server error as it is", async () => {
      const client = createTestClient({ maxRetries: 1 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(503, { message: "Unavailable" })
        .get("/api/1.0/balances")
        .reply(404, { message: "Not found" });

      const error = await client.getBalances().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it("treats an unreadable reply as one that may have reached the exchange", async () => {
      const client = createTestClient();
      nock(BASE_URL).post("/api/1.0/orders").reply(200, '{"data": {"venue');

      const error = await placeOrder(client);

      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).mayHaveReachedServer).toBe(true);
      expect((error as NetworkError).message).toMatch(
        /^The exchange's reply couldn't be read: [^.]+[^.]\.$/,
      );
    });

    it("keeps the same client order id when an order is retried after a server error", async () => {
      const client = createTestClient({ maxRetries: 1 });
      const bodies: Record<string, unknown>[] = [];
      nock(BASE_URL)
        .post("/api/1.0/orders", (body) => {
          bodies.push(body);
          return true;
        })
        .reply(500, { message: "Internal error" })
        .post("/api/1.0/orders", (body) => {
          bodies.push(body);
          return true;
        })
        .reply(200, {
          data: { venue_order_id: "v-1", client_order_id: "c-1", state: "new" },
        });

      await client.placeOrder({
        symbol: "BTC-USD",
        side: "buy",
        limit: { price: "90000", baseSize: "0.001" },
      });

      expect(bodies).toHaveLength(2);
      expect(bodies[1].client_order_id).toBe(bodies[0].client_order_id);
    });
  });
});
