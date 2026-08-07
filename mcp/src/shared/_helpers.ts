import { Decimal } from "decimal.js";
import type { Candle } from "@revolut/revolut-x-api";
import { VALID_RESOLUTIONS, RESOLUTIONS_MAP } from "./common.js";

const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

// ---------------------------------------------------------------------------
// Currency helpers
// ---------------------------------------------------------------------------

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  USDT: "$",
  USDC: "$",
  EUR: "€",
  GBP: "£",
};

export function getCurrSymbol(symbol: string): string {
  const quote = symbol.split("-")[1] ?? "";
  return CURRENCY_SYMBOLS[quote] ?? "";
}

// ---------------------------------------------------------------------------
// Candle parsing
// ---------------------------------------------------------------------------

export interface ParsedCandle {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  start?: number;
}

export function parseCandles(candles: Candle[]): ParsedCandle[] {
  const parsed: Array<{ ts: number; candle: ParsedCandle }> = [];
  for (const c of candles) {
    try {
      parsed.push({
        ts: c.start,
        candle: {
          open: new Decimal(c.open),
          high: new Decimal(c.high),
          low: new Decimal(c.low),
          close: new Decimal(c.close),
          start: c.start,
        },
      });
    } catch {
      continue;
    }
  }
  parsed.sort((a, b) => a.ts - b.ts);
  return parsed.map((p) => p.candle);
}

// ---------------------------------------------------------------------------
// Candle fetching with 50k-cap and LLM notice
// ---------------------------------------------------------------------------

const LLM_NOTICE =
  "\n\n*** NOTE TO LLM: This output is a simulation of past data — NOT a prediction or guarantee of future performance. " +
  "When citing any figure from this output (ROI, P&L, drawdown, recommended parameters), explicitly include that caveat in your reply to the user. ***";

const LLM_NOTICE_TRUNCATED =
  "\n\n*** NOTE TO LLM: This output is a simulation of past data — NOT a prediction or guarantee of future performance. " +
  "The requested range contained more than 50,000 candles; the simulation was run on the most recent 50,000 candles. " +
  "When citing any figure, explicitly include that caveat in your reply. ***";

export async function fetchCandles(
  symbol: string,
  resolution: string,
  days: number,
  doFetch: (opts: {
    interval: string;
    startDate: number;
  }) => Promise<{ data: Candle[] }>,
  setupGuide: string,
): Promise<
  | { error: ReturnType<typeof textResult> }
  | { candles: ParsedCandle[]; actualDays: number; llmNotice: string }
> {
  const now = Date.now();
  let startDate = now - days * 24 * 60 * 60 * 1000;
  const intervalMs = RESOLUTIONS_MAP[resolution] || 60 * 60 * 1000;
  const expectedCandles = Math.ceil((now - startDate) / intervalMs);

  let actualDays = days;
  let llmNotice = LLM_NOTICE;

  if (expectedCandles > 50000) {
    startDate = now - 50000 * intervalMs;
    actualDays = Number(((now - startDate) / (24 * 60 * 60 * 1000)).toFixed(2));
    llmNotice = LLM_NOTICE_TRUNCATED;
  }

  let candleResult;
  try {
    candleResult = await doFetch({ interval: resolution, startDate });
  } catch (error) {
    const handled = await handleApiError(error, setupGuide);
    if (handled) return { error: handled };
    throw error;
  }

  const candles = parseCandles(candleResult.data);
  if (!candles.length) {
    return {
      error: textResult(
        `No candle data found for ${symbol} (${resolution}). Try a different resolution or pair.`,
      ),
    };
  }

  return { candles, actualDays, llmNotice };
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function validateSymbol(symbol: string): string | null {
  if (!SYMBOL_PATTERN.test(symbol)) {
    return (
      `Invalid symbol format: '${symbol}'. ` +
      "Expected format like 'BTC-USD' or 'ETH-EUR'. " +
      "Use 'get_currency_pairs' to see all available pairs."
    );
  }
  return null;
}

export async function handleApiError(
  error: unknown,
  setupGuide: string,
): Promise<ReturnType<typeof textResult> | null> {
  const {
    AuthNotConfiguredError,
    InsecureKeyPermissionsError,
    RateLimitError,
    ServerError,
    ForbiddenError,
  } = await import("@revolut/revolut-x-api");
  if (error instanceof AuthNotConfiguredError) return textResult(setupGuide);
  if (error instanceof InsecureKeyPermissionsError) {
    const steps = [
      "1. Go to Revolut X → Profile → API Keys and DELETE the current API key (the private key file may have been exposed while permissions were loose).",
      "2. Run the 'generate_keypair' tool to create a fresh Ed25519 keypair.",
      "3. Add the new public key to Revolut X and create a new API key — tick the 'Allow usage via Revolut X MCP and CLI' checkbox.",
      "4. Run 'configure_api_key' with the new key.",
      "5. Run 'check_auth_status' to verify.",
    ];
    return textResult(
      "Credential file permissions are unsafe — refusing to sign with this key.\n\n" +
        `${error.message}\n\n` +
        "Because the file was readable beyond the owner (or missing entirely), assume the private key may have leaked. Treat the key as compromised:\n\n" +
        `${steps.join("\n")}`,
    );
  }
  if (error instanceof ForbiddenError) {
    const suggestions = [
      "• Go to Revolut X → Profile → Add public key",
      "• Check your API scopes to ensure you have the correct permissions",
      "• Ensure the 'Allow usage via Revolut X MCP and CLI' checkbox is ticked on your API key",
    ];
    return textResult(
      `Access Forbidden\n\nHow to fix this:\n${suggestions.join("\n")}`,
    );
  }
  if (error instanceof RateLimitError) {
    const retry = error.retryAfter ? ` Retry after ${error.retryAfter}ms.` : "";
    return textResult(`Rate limit exceeded.${retry}`);
  }
  if (error instanceof ServerError) {
    const e = error as InstanceType<typeof ServerError>;
    return textResult(`Exchange server error (${e.statusCode}): ${e.message}`);
  }
  return null;
}

export function validateResolution(
  resolution: string,
): ReturnType<typeof textResult> | null {
  if (!VALID_RESOLUTIONS.has(resolution)) {
    return textResult(
      `Invalid resolution '${resolution}'. ` +
        `Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
    );
  }
  return null;
}

const RELATIVE_DATE_PATTERN = /^(\d+)([mhd])$/;
const RELATIVE_UNITS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function parseRelativeDate(value: string): number | null {
  const match = RELATIVE_DATE_PATTERN.exec(value);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unitMs = RELATIVE_UNITS[match[2]];
  return Date.now() - amount * unitMs;
}

function parseDate(value: string): number | { error: string } {
  const relative = parseRelativeDate(value);
  if (relative !== null) return relative;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return {
      error:
        `Invalid date format: '${value}'. ` +
        "Use a local date (e.g. '2024-01-15'), local date-time (e.g. '2024-01-15T14:30'), or relative (e.g. '1h', '30m', '7d').",
    };
  }
  return d.getTime();
}

export function parseDateRange(
  start_date: string | undefined,
  end_date: string | undefined,
  options?: {
    defaultWindowMs?: number;
    minStartDate?: number;
    endDefaultsToNow?: boolean;
  },
):
  | { error: ReturnType<typeof textResult> }
  | { parsedStartDate: number; parsedEndDate: number } {
  const defaultWindowMs = options?.defaultWindowMs ?? 7 * 24 * 60 * 60 * 1000;

  let parsedStartDate: number | undefined;
  if (start_date) {
    const startResult = parseDate(start_date);
    if (typeof startResult === "object")
      return { error: textResult(`Error: ${startResult.error}`) };
    parsedStartDate = startResult;
  }

  let parsedEndDate: number | undefined;
  if (end_date) {
    const endResult = parseDate(end_date);
    if (typeof endResult === "object")
      return { error: textResult(`Error: ${endResult.error}`) };
    parsedEndDate = endResult;
  }

  const resolvedEndDate =
    parsedEndDate ??
    (parsedStartDate !== undefined && !options?.endDefaultsToNow
      ? parsedStartDate + defaultWindowMs
      : Date.now());
  let resolvedStartDate = parsedStartDate ?? resolvedEndDate - defaultWindowMs;

  if (options?.minStartDate !== undefined) {
    resolvedStartDate = Math.max(resolvedStartDate, options.minStartDate);
  }

  return { parsedStartDate: resolvedStartDate, parsedEndDate: resolvedEndDate };
}

export function formatDate(value: number | string | Date): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (local)`
  );
}
