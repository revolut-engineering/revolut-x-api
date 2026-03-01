import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import nock from "nock";
import { RevolutXClient } from "../../src/shared/client/api-client.js";
import { RateLimiter } from "../../src/shared/client/rate-limiter.js";
import {
  AuthenticationError,
  RateLimitError,
  OrderError,
  NotFoundError,
  RevolutXAPIError,
} from "../../src/shared/client/exceptions.js";

const BASE_URL = "https://revx.revolut.com";

describe("RevolutXClient", () => {
  let client: RevolutXClient;
  let privateKey: KeyObject;

  beforeAll(() => {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;

    client = new RevolutXClient({
      baseUrl: BASE_URL,
      rateLimiter: new RateLimiter(),
      credentials: { apiKey: "test-api-key", privateKey },
      maxRetries: 3,
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it("getBalances returns parsed JSON", async () => {
    const payload = [{ currency: "BTC", amount: "1.5" }];
    nock(BASE_URL).get("/api/1.0/balances").reply(200, payload);

    const result = await client.getBalances();
    expect(result).toEqual(payload);
  });

  it("401 throws AuthenticationError", async () => {
    nock(BASE_URL)
      .get("/api/1.0/balances")
      .reply(401, { message: "Invalid API key" });

    await expect(client.getBalances()).rejects.toThrow(AuthenticationError);
  });

  it("429 throws RateLimitError", async () => {
    nock(BASE_URL)
      .get("/api/1.0/balances")
      .reply(429, { message: "Too many requests" });

    await expect(client.getBalances()).rejects.toThrow(RateLimitError);
  });

  it("400 throws OrderError", async () => {
    nock(BASE_URL)
      .post("/api/1.0/orders")
      .reply(400, { message: "Insufficient funds" });

    await expect(
      client.placeOrder("id-1", "BTC-USD", "buy", { type: "market" }),
    ).rejects.toThrow(OrderError);
  });

  it("404 throws NotFoundError", async () => {
    nock(BASE_URL)
      .get("/api/1.0/orders/active")
      .reply(404, { message: "Not found" });

    await expect(client.getActiveOrders()).rejects.toThrow(NotFoundError);
  });

  it("placeOrder sends POST with JSON body", async () => {
    const scope = nock(BASE_URL)
      .post("/api/1.0/orders", (body: Record<string, unknown>) => {
        return (
          body.client_order_id === "order-1" &&
          body.symbol === "BTC-USD" &&
          body.side === "buy"
        );
      })
      .reply(200, { order_id: "v-123" });

    const result = await client.placeOrder("order-1", "BTC-USD", "buy", {
      type: "market",
      amount: "0.01",
    });
    expect(result).toEqual({ order_id: "v-123" });
    expect(scope.isDone()).toBe(true);
  });

  it("cancelOrder sends DELETE", async () => {
    const scope = nock(BASE_URL)
      .delete("/api/1.0/orders/v-123")
      .reply(204);

    const result = await client.cancelOrder("v-123");
    expect(result).toEqual({});
    expect(scope.isDone()).toBe(true);
  });

  it("retries on 500", async () => {
    nock(BASE_URL)
      .get("/api/1.0/balances")
      .reply(500, { message: "Internal error" })
      .get("/api/1.0/balances")
      .reply(500, { message: "Internal error" })
      .get("/api/1.0/balances")
      .reply(200, { ok: true });

    const result = await client.getBalances();
    expect(result).toEqual({ ok: true });
  });

  it("does not retry on 4xx", async () => {
    const scope = nock(BASE_URL)
      .get("/api/1.0/balances")
      .reply(403, { message: "Forbidden" });

    await expect(client.getBalances()).rejects.toThrow(AuthenticationError);
    expect(scope.isDone()).toBe(true);
    // No additional requests should have been made
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it("204 returns empty object", async () => {
    nock(BASE_URL).delete("/api/1.0/orders/v-456").reply(204);

    const result = await client.cancelOrder("v-456");
    expect(result).toEqual({});
  });
});
