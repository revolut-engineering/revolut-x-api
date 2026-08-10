import { RateLimitError } from "@revolut/revolut-x-api";

export interface RateWindow {
  limit: number;
  intervalMs: number;
  onExhausted: "wait" | "reject";
}

export class SlidingWindowRateLimiter {
  private readonly _windows: RateWindow[];
  private readonly _timestamps: number[] = [];
  private _reservationQueue: Promise<void> = Promise.resolve();

  constructor(windows: RateWindow[]) {
    this._windows = windows;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this._acquire();
    return operation();
  }

  private async _acquire(): Promise<void> {
    const reservation = this._reservationQueue.then(() => this._reserve());
    this._reservationQueue = reservation.catch(() => undefined);
    return reservation;
  }

  private async _reserve(): Promise<void> {
    while (true) {
      const now = Date.now();
      const longestWindow = Math.max(
        ...this._windows.map((window) => window.intervalMs),
      );
      while (
        this._timestamps.length > 0 &&
        this._timestamps[0] <= now - longestWindow
      ) {
        this._timestamps.shift();
      }

      let waitMs = 0;
      for (const window of this._windows) {
        const recent = this._timestamps.filter(
          (timestamp) => timestamp > now - window.intervalMs,
        );
        if (recent.length < window.limit) continue;
        if (window.onExhausted === "reject") {
          throw new Error(
            `Local rate limit exhausted: ${window.limit} requests per ${window.intervalMs}ms.`,
          );
        }
        const oldestBlocking = recent[recent.length - window.limit];
        waitMs = Math.max(waitMs, oldestBlocking + window.intervalMs - now);
      }

      if (waitMs <= 0) {
        this._timestamps.push(now);
        return;
      }
      await sleep(waitMs);
    }
  }
}

export class ExchangeRateLimiter {
  private readonly _placementLimiter = new SlidingWindowRateLimiter([
    { limit: 10, intervalMs: 1000, onExhausted: "wait" },
    { limit: 1000, intervalMs: 86_400_000, onExhausted: "reject" },
  ]);
  private readonly _orderLimiter = new SlidingWindowRateLimiter([
    { limit: 100, intervalMs: 1000, onExhausted: "wait" },
    { limit: 1000, intervalMs: 60_000, onExhausted: "wait" },
  ]);

  async place<T>(operation: () => Promise<T>): Promise<T> {
    return this._runWithRetry(this._placementLimiter, operation);
  }

  async cancel<T>(operation: () => Promise<T>): Promise<T> {
    return this._runWithRetry(this._orderLimiter, operation);
  }

  async query<T>(operation: () => Promise<T>): Promise<T> {
    return this._runWithRetry(this._orderLimiter, operation);
  }

  private async _runWithRetry<T>(
    limiter: SlidingWindowRateLimiter,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await limiter.run(operation);
    } catch (err) {
      if (
        !(err instanceof RateLimitError) ||
        err.retryAfter === undefined ||
        err.retryAfter < 0 ||
        err.retryAfter > 5000
      ) {
        throw err;
      }
      await sleep(err.retryAfter);
      return limiter.run(operation);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
