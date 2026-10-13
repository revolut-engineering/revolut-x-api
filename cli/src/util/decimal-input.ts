import { Decimal } from "decimal.js";

const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d{1,4})?$/i;
const MAX_INTEGER_DIGITS = 15;
const MAX_DECIMAL_PLACES = 18;

export const ExactDecimal = Decimal.clone({ precision: 200 });

export function parseDecimal(value: string): Decimal | null {
  const text = value.trim();
  return DECIMAL_PATTERN.test(text) ? new ExactDecimal(text) : null;
}

export function decimalLimitProblem(number: Decimal): string | null {
  if (number.e >= MAX_INTEGER_DIGITS) return "is too large";
  if (number.decimalPlaces() > MAX_DECIMAL_PLACES) {
    return `has more than ${MAX_DECIMAL_PLACES} decimal places`;
  }
  return null;
}

export function groupedNumber(number: Decimal): string {
  const [whole, fraction] = number.abs().toFixed().split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = number.isNegative() && !number.isZero() ? "-" : "";
  return `${sign}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}
