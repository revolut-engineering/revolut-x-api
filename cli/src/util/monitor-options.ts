import { decimalLimitProblem, parseDecimal } from "./decimal-input.js";

export const MONITOR_CANDLES = 100;
export const MIN_CHECK_INTERVAL_SEC = 5;
export const MAX_CHECK_INTERVAL_SEC = 86_400;
const MAX_PERIOD = MONITOR_CANDLES - 1;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

export class MonitorOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorOptionError";
  }
}

export interface DecimalRange {
  min?: number;
  max?: number;
  above?: number;
  below?: number;
}

function describeRange(range: DecimalRange): string {
  const lower =
    range.above !== undefined
      ? `above ${range.above}`
      : range.min !== undefined
        ? `at least ${range.min}`
        : null;
  const upper =
    range.below !== undefined
      ? `below ${range.below}`
      : range.max !== undefined
        ? `at most ${range.max}`
        : null;
  if (range.min !== undefined && range.max !== undefined) {
    return `from ${range.min} to ${range.max}`;
  }
  return [lower, upper].filter(Boolean).join(" and ");
}

export function decimalOption(
  flag: string,
  value: string,
  range: DecimalRange,
): string {
  const text = value.trim();
  const number = parseDecimal(text);
  if (number === null) {
    throw new MonitorOptionError(`${flag} must be a number, got "${value}".`);
  }
  const problem = decimalLimitProblem(number);
  if (problem) {
    throw new MonitorOptionError(`${flag} ${problem}, got "${text}".`);
  }
  const outside =
    (range.above !== undefined && !number.gt(range.above)) ||
    (range.min !== undefined && number.lt(range.min)) ||
    (range.below !== undefined && !number.lt(range.below)) ||
    (range.max !== undefined && number.gt(range.max));
  if (outside) {
    throw new MonitorOptionError(
      `${flag} must be ${describeRange(range)}, got "${text}".`,
    );
  }
  return number.toFixed();
}

export function periodOption(
  flag: string,
  value: string,
  min = 1,
  max = MAX_PERIOD,
): number {
  const text = value.trim();
  if (!WHOLE_NUMBER_PATTERN.test(text)) {
    throw new MonitorOptionError(
      `${flag} must be a whole number, got "${value}".`,
    );
  }
  const period = Number(text);
  if (period < min || period > max) {
    const candles =
      period > max
        ? ` The monitor reads the last ${MONITOR_CANDLES} hourly candles.`
        : "";
    throw new MonitorOptionError(
      `${flag} must be from ${min} to ${max}, got "${text}".${candles}`,
    );
  }
  return period;
}

export function intervalOption(value: string): number {
  const text = value.trim();
  if (!WHOLE_NUMBER_PATTERN.test(text)) {
    throw new MonitorOptionError(
      `--interval must be a whole number of seconds, got "${value}".`,
    );
  }
  const seconds = Number(text);
  if (seconds < MIN_CHECK_INTERVAL_SEC || seconds > MAX_CHECK_INTERVAL_SEC) {
    throw new MonitorOptionError(
      `--interval must be from ${MIN_CHECK_INTERVAL_SEC} to ${MAX_CHECK_INTERVAL_SEC} seconds, got "${text}".`,
    );
  }
  return seconds;
}
