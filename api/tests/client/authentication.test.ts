import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { createTestClient, BASE_URL } from "../helpers/test-utils.js";
import {
  AuthNotConfiguredError,
  AuthenticationError,
  ForbiddenError,
} from "../../src/http/errors.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Authentication", () => {
  describe("isAuthenticated", () => {
    it("returns true when credentials are provided", () => {
      const client = createTestClient({ authenticated: true });
      expect(client.isAuthenticated).toBe(true);
    });

    it("returns false when credentials are missing", () => {
      const client = createTestClient({ authenticated: false });
      expect(client.isAuthenticated).toBe(false);
    });

    it("returns false when only API key is provided", () => {
      const client = createTestClient({ authenticated: false });
      expect(client.isAuthenticated).toBe(false);
    });
  });

  describe("requireAuth", () => {
    it("throws AuthNotConfiguredError for unauthenticated requests", async () => {
      const client = createTestClient({ authenticated: false });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthNotConfiguredError);
        expect((err as Error).message).toContain("credentials not configured");
      }
    });

    it("allows authenticated requests when credentials present", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(200, [
          { currency: "BTC", available: "1.0", reserved: "0", total: "1.0" },
        ]);

      const result = await client.getBalances();
      expect(result).toHaveLength(1);
    });

    it("includes authentication headers in requests", async () => {
      const client = createTestClient();
      let hasAuthHeaders = false;

      nock(BASE_URL)
        .get("/api/1.0/balances")
        .matchHeader("X-Revx-API-Key", "test-api-key")
        .matchHeader("X-Revx-Timestamp", (value) => {
          return typeof value === "string" && !isNaN(Number(value));
        })
        .matchHeader("X-Revx-Signature", (value) => {
          hasAuthHeaders = typeof value === "string" && value.length > 0;
          return hasAuthHeaders;
        })
        .reply(200, []);

      await client.getBalances();
      expect(hasAuthHeaders).toBe(true);
    });
  });

  describe("authentication vs authorization", () => {
    it("throws AuthenticationError (401) for invalid credentials", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Invalid API key" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).statusCode).toBe(401);
      }
    });

    it("throws ForbiddenError (403) for valid credentials with insufficient permissions", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .post("/api/1.0/orders")
        .reply(403, {
          message: "API key does not have trading permissions",
        });

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
        expect(err).not.toBeInstanceOf(AuthenticationError);
      }
    });

    it("throws ForbiddenError when accessing restricted resources", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/orders/other-user-order")
        .reply(403, { message: "Cannot access other user's orders" });

      try {
        await client.getOrder("other-user-order");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as Error).message).toContain("other user's orders");
      }
    });

    it("handles missing signature as authentication error", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Missing signature header" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as Error).message).toContain("Missing signature");
      }
    });

    it("handles expired signature as authentication error", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(401, { message: "Signature timestamp expired" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as Error).message).toContain("expired");
      }
    });

    it("handles account suspension as forbidden error", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/balances")
        .reply(403, { message: "Account suspended" });

      try {
        await client.getBalances();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as Error).message).toContain("suspended");
      }
    });
  });
});
