import { randomUUID } from "node:crypto";
import type { Decimal } from "decimal.js";
import {
  ExactDecimal,
  decimalLimitProblem,
  parseDecimal,
} from "./decimal-input.js";

const SYMBOL_FORMAT = /^[A-Z0-9]+-[A-Z0-9]+$/;

export class OrderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderInputError";
  }
}

export function orderAmount(flag: string, value: string): string {
  const text = value.trim();
  const amount = parseDecimal(text);
  if (amount === null || amount.isNegative()) {
    throw new OrderInputError(
      `${flag} must be a positive number, got "${value}".`,
    );
  }
  if (amount.isZero()) {
    throw new OrderInputError(`${flag} must be greater than 0, got "${text}".`);
  }
  const problem = decimalLimitProblem(amount);
  if (problem) {
    throw new OrderInputError(`${flag} ${problem}, got "${text}".`);
  }
  return amount.toFixed();
}

function readStep(step: unknown): Decimal | null {
  try {
    const tick = new ExactDecimal(String(step));
    return tick.isFinite() && tick.gt(0) ? tick : null;
  } catch {
    return null;
  }
}

export function assertOnPriceStep(
  flag: string,
  price: string,
  step: unknown,
  pair: string,
): void {
  const tick = readStep(step);
  if (!tick) return;
  const value = new ExactDecimal(price);
  if (value.mod(tick).isZero()) return;
  const lower = value.divToInt(tick).times(tick);
  const upper = lower.plus(tick);
  const nearest = lower.isZero()
    ? `The nearest valid price is ${upper.toFixed()}.`
    : `The nearest valid prices are ${lower.toFixed()} and ${upper.toFixed()}.`;
  throw new OrderInputError(
    `${flag} ${value.toFixed()} is not a multiple of the ${pair} price step ${tick.toFixed()}. ${nearest}`,
  );
}

export function orderSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!SYMBOL_FORMAT.test(symbol)) {
    throw new OrderInputError(
      `The pair must look like BTC-USD, got "${value}".`,
    );
  }
  return symbol;
}

export function clientOrderIdOption(value: string | undefined): string {
  if (value === undefined) return randomUUID();
  if (!value.trim()) {
    throw new OrderInputError("--client-order-id must not be empty.");
  }
  return value;
}
