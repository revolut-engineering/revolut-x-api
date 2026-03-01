import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenBucket, RateLimiter } from "../../src/shared/client/rate-limiter.js";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows acquire within capacity", async () => {
    const bucket = new TokenBucket(5, 60);
    // Should resolve immediately for 5 tokens
    for (let i = 0; i < 5; i++) {
      await bucket.acquire();
    }
  });

  it("blocks when exhausted", async () => {
    const bucket = new TokenBucket(1, 60);
    await bucket.acquire(); // consumes the only token

    let resolved = false;
    const p = bucket.acquire().then(() => {
      resolved = true;
    });

    // Advance less than needed for refill — should still be blocked
    await vi.advanceTimersByTimeAsync(40);
    expect(resolved).toBe(false);

    // Advance enough for 1 token to refill (60s for 1 token)
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(resolved).toBe(true);
  });

  it("refills over time", async () => {
    const bucket = new TokenBucket(10, 10); // 1 token/sec
    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      await bucket.acquire();
    }

    // Advance 2 seconds — should refill ~2 tokens
    await vi.advanceTimersByTimeAsync(2000);
    await bucket.acquire();
    await bucket.acquire();
  });

  it("caps at capacity", async () => {
    const bucket = new TokenBucket(3, 60);
    // Advance a lot of time — tokens should not exceed capacity
    await vi.advanceTimersByTimeAsync(120_000);
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    let resolved = false;
    bucket.acquire().then(() => {
      resolved = true;
    });
    // Should be blocked — only 3 tokens max
    await vi.advanceTimersByTimeAsync(40);
    expect(resolved).toBe(false);
  });
});

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquireGeneral works", async () => {
    const limiter = new RateLimiter(100, 20);
    await limiter.acquireGeneral();
  });

  it("acquireLastTrades consumes both buckets", async () => {
    // General: capacity 2, LastTrades: capacity 1
    const limiter = new RateLimiter(2, 1);
    await limiter.acquireLastTrades(); // consumes 1 general + 1 lastTrades

    // General still has 1 token
    await limiter.acquireGeneral();

    // Now general is exhausted — next acquireGeneral should block
    let resolved = false;
    limiter.acquireGeneral().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(resolved).toBe(false);
  });
});
