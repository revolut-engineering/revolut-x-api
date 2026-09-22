import type { Decimal } from "decimal.js";

export class StablePriceTracker {
  private _consecutiveTicks = 0;

  constructor(private readonly _requiredConsecutiveTicks: number) {
    if (
      !Number.isInteger(_requiredConsecutiveTicks) ||
      _requiredConsecutiveTicks <= 0
    ) {
      throw new RangeError(
        "requiredConsecutiveTicks must be a positive integer",
      );
    }
  }

  observe(price: Decimal, condition: (price: Decimal) => boolean): boolean {
    if (!condition(price)) {
      this.reset();
      return false;
    }

    this._consecutiveTicks += 1;
    return this._consecutiveTicks >= this._requiredConsecutiveTicks;
  }

  reset(): void {
    this._consecutiveTicks = 0;
  }
}
