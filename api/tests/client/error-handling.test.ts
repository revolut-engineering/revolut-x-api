import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { createTestClient, BASE_URL } from "../helpers/test-utils.js";
import {
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  OrderError,
  RateLimitError,
  ServerError,
  ConflictError,
} from "../../src/http/errors.js";

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
      ).rejects.toThrow(OrderError);
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
      ).rejects.toThrow(OrderError);
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
    it("throws network errors immediately without retry", async () => {
      const client = createTestClient({ maxRetries: 1, timeout: 100 });
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .replyWithError(new TypeError("fetch failed"));

      await expect(client.getBalances()).rejects.toThrow(TypeError);
      expect(nock.pendingMocks()).toHaveLength(0);
    });
  });
});
