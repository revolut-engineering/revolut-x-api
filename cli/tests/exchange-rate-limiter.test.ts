import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@revolut/revolut-x-api";
import {
  ExchangeRateLimiter,
  SlidingWindowRateLimiter,
} from "../src/engine/exchange-rate-limiter.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("exchange rate limiter", () => {
  it("releases no more than ten placements per second", async () => {
    // given
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ExchangeRateLimiter();
    let calls = 0;

    // when
    const results = Array.from({ length: 11 }, () =>
      limiter.place(async () => ++calls),
    );
    await vi.advanceTimersByTimeAsync(0);

    // then
    expect(calls).toBe(10);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(10);
    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all(results)).resolves.toHaveLength(11);
    expect(calls).toBe(11);
  });

  it("releases a full split grid in twenty seconds", async () => {
    // given
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ExchangeRateLimiter();
    let calls = 0;

    // when
    const results = Array.from({ length: 201 }, () =>
      limiter.place(async () => ++calls),
    );
    await vi.advanceTimersByTimeAsync(19_999);

    // then
    expect(calls).toBe(200);
    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all(results)).resolves.toHaveLength(201);
    expect(calls).toBe(201);
  });

  it("fails fast when a reject window is exhausted", async () => {
    // given
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new SlidingWindowRateLimiter([
      { limit: 2, intervalMs: 1000, onExhausted: "wait" },
      { limit: 3, intervalMs: 10_000, onExhausted: "reject" },
    ]);

    // when
    const results = Array.from({ length: 4 }, () => limiter.run(async () => 1));
    const assertion = expect(Promise.all(results)).rejects.toThrow(
      /rate limit exhausted/i,
    );
    await vi.advanceTimersByTimeAsync(1000);

    // then
    await assertion;
  });

  it("retries one short server rate limit using millisecond retry-after", async () => {
    // given
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ExchangeRateLimiter();
    let attempts = 0;

    // when
    const result = limiter.place(async () => {
      attempts++;
      if (attempts === 1) {
        throw new RateLimitError("slow down", 250);
      }
      return "placed";
    });
    await vi.advanceTimersByTimeAsync(249);

    // then
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("placed");
    expect(attempts).toBe(2);
  });

  it("does not wait on a long server rate limit", async () => {
    // given
    const limiter = new ExchangeRateLimiter();
    let attempts = 0;

    // when
    const result = limiter.place(async () => {
      attempts++;
      throw new RateLimitError("daily limit", 5001);
    });

    // then
    await expect(result).rejects.toThrow("daily limit");
    expect(attempts).toBe(1);
  });
});
