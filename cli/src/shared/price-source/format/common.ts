import { Decimal } from "decimal.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export function pickDecimal(
  obj: Record<string, unknown>,
  keys: string[],
): Decimal | undefined {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) {
      return new Decimal(String(obj[k]));
    }
  }
  return undefined;
}

export function pickPrice(obj: Record<string, unknown>): Decimal {
  for (const k of ["price", "p", "close", "c", "last", "mid"]) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) {
      return new Decimal(String(obj[k]));
    }
  }
  throw new ParseError("NDJSON line missing a 'price' field");
}
