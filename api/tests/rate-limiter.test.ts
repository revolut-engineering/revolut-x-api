import { describe, it, expect } from "vitest";
import { TokenBucket, RateLimiter } from "../src/http/rate-limiter.js";

describe("TokenBucket", () => {
  it("allows immediate acquire when full", async () => {
    const bucket = new TokenBucket(10, 1);
    const start = Date.now();
    await bucket.acquire();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("depletes tokens and waits for refill", async () => {
    // capacity=3, refillPeriod=1s → refill rate = 3 tokens/sec → ~333ms per token
    const bucket = new TokenBucket(3, 1);
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    // 4th should block until a token refills (~333ms)
    const start = Date.now();
    await bucket.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });
});

describe("RateLimiter", () => {
  it("acquireGeneral works immediately", async () => {
    const limiter = new RateLimiter(1000, 20);
    const start = Date.now();
    await limiter.acquireGeneral();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("acquirePublic works immediately", async () => {
    const limiter = new RateLimiter(1000, 20);
    const start = Date.now();
    await limiter.acquirePublic();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("acquirePublic does not consume from general bucket", async () => {
    // general=2, public=20 — 3 public calls should NOT block on general
    const limiter = new RateLimiter(2, 20);
    const start = Date.now();
    await limiter.acquirePublic();
    await limiter.acquirePublic();
    await limiter.acquirePublic();
    // If public consumed general tokens, the 3rd call would block (~30s at 2/min)
    expect(Date.now() - start).toBeLessThan(200);
  });
});
