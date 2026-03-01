/**
 * Token-bucket rate limiter for Revolut X API.
 */

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPeriod: number;
  private tokens: number;
  private lastRefill: number;

  constructor(capacity: number, refillPeriod: number) {
    this.capacity = capacity;
    this.refillPeriod = refillPeriod;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * (this.capacity / this.refillPeriod);
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1.0) {
        this.tokens -= 1.0;
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export class RateLimiter {
  private readonly general: TokenBucket;
  private readonly lastTrades: TokenBucket;

  constructor(generalRpm: number = 1000, lastTradesPer10s: number = 20) {
    this.general = new TokenBucket(generalRpm, 60);
    this.lastTrades = new TokenBucket(lastTradesPer10s, 10);
  }

  async acquireGeneral(): Promise<void> {
    await this.general.acquire();
  }

  async acquireLastTrades(): Promise<void> {
    await this.general.acquire();
    await this.lastTrades.acquire();
  }
}
