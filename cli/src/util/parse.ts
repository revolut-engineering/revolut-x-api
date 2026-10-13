const EPOCH_MS_PATTERN = /^\d{13}$/;
const EPOCH_SECONDS_PATTERN = /^\d{10}$/;
const RELATIVE_PATTERN = /^(\d+)\s*(d|days?|w|weeks?|h|hours?|m|minutes?)$/;
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_FORMATS =
  "Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, a relative time like 7d, today, yesterday or epoch milliseconds.";
const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  w: 7 * 86_400_000,
  h: 3_600_000,
  m: 60_000,
};

const BEFORE_EPOCH = "That is before 1970.";

function invalidDate(value: string, reason = DATE_FORMATS): Error {
  return new Error(`Invalid date: "${value}". ${reason}`);
}

function startOfToday(daysBack: number): number {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - daysBack);
  return day.getTime();
}

function parseCalendarDate(value: string, text: string): number {
  const parts = text.toUpperCase().match(DATE_TIME_PATTERN);
  if (!parts) throw invalidDate(value);
  const [, y, mo, d, h, mi = "00", sec = "00", fraction = "", zone] = parts;
  const [year, month, day, hours, minutes, seconds] = [
    y,
    mo,
    d,
    h ?? "0",
    mi,
    sec,
  ].map(Number);
  const millis = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const check = new Date(
    Date.UTC(year, month - 1, day, hours, minutes, seconds),
  );
  const valid =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hours &&
    check.getUTCMinutes() === minutes &&
    check.getUTCSeconds() === seconds;
  if (!valid) throw invalidDate(value);
  if (zone) {
    const offset = zone === "Z" ? zone : zone.replace(/^([+-]\d{2}):?/, "$1:");
    const instant = Date.parse(
      `${y}-${mo}-${d}T${h}:${mi}:${sec}.${String(millis).padStart(3, "0")}${offset}`,
    );
    if (Number.isNaN(instant)) throw invalidDate(value);
    if (instant < 0) throw invalidDate(value, BEFORE_EPOCH);
    return instant;
  }
  const local = new Date(year, month - 1, day, hours, minutes, seconds, millis);
  if (
    h !== undefined &&
    (local.getDate() !== day ||
      local.getHours() !== hours ||
      local.getMinutes() !== minutes)
  ) {
    throw invalidDate(
      value,
      "That local time doesn't exist, because the clock changes then.",
    );
  }
  if (local.getTime() < 0) throw invalidDate(value, BEFORE_EPOCH);
  return local.getTime();
}

export function parseTimestamp(value: string): number {
  const text = value.trim().toLowerCase();
  if (text === "today") return startOfToday(0);
  if (text === "yesterday") return startOfToday(1);

  const relative = text.match(RELATIVE_PATTERN);
  if (relative) {
    const instant = Date.now() - Number(relative[1]) * UNIT_MS[relative[2][0]];
    if (!Number.isSafeInteger(instant) || instant < 0) {
      throw invalidDate(value, BEFORE_EPOCH);
    }
    return instant;
  }

  if (EPOCH_MS_PATTERN.test(text)) return Number(text);
  if (EPOCH_SECONDS_PATTERN.test(text)) {
    throw invalidDate(
      value,
      `It looks like epoch seconds. Use milliseconds, for example ${text}000.`,
    );
  }
  return parseCalendarDate(value, text);
}

export function parseDateRange(
  start: string | undefined,
  end: string | undefined,
  [startName, endName]: [string, string] = ["--start-date", "--end-date"],
): { start: number | undefined; end: number | undefined } {
  const range = {
    start: start !== undefined ? parseTimestamp(start) : undefined,
    end: end !== undefined ? parseTimestamp(end) : undefined,
  };
  if (
    range.start !== undefined &&
    range.end !== undefined &&
    range.start > range.end
  ) {
    throw new Error(`${startName} must be before ${endName}.`);
  }
  return range;
}

export interface DateWindow {
  start: number;
  end: number;
  givenStart: number | undefined;
  givenEnd: number | undefined;
}

export function resolveDateWindow(
  start: string | undefined,
  end: string | undefined,
  defaultSpanMs: number,
  names: [string, string] = ["--start-date", "--end-date"],
): DateWindow {
  const given = parseDateRange(start, end, names);
  const now = Date.now();
  const windowEnd = Math.min(given.end ?? now, now);
  const windowStart = given.start ?? windowEnd - defaultSpanMs;
  if (windowStart > windowEnd) {
    throw new Error(`${names[0]} is in the future.`);
  }
  return {
    start: windowStart,
    end: windowEnd,
    givenStart: given.start,
    givenEnd: given.end,
  };
}

export function parsePositiveInt(value: string, name: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    console.error(`Error: ${name} must be a positive integer, got: ${value}`);
    process.exit(1);
  }
  return num;
}

export function parseIntInRange(
  value: string,
  name: string,
  min: number,
  max: number,
): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    console.error(
      `Error: ${name} must be an integer between ${min} and ${max}, got: ${value}`,
    );
    process.exit(1);
  }
  return num;
}
