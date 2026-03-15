const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

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

export function validateSide(side: string): string | null {
  if (side !== "buy" && side !== "sell") {
    return `Invalid side: '${side}'. Must be 'buy' or 'sell'.`;
  }
  return null;
}

export function validateDecimal(value: string, name: string): string | null {
  const f = Number(value);
  if (isNaN(f)) {
    return `${name} must be a valid number, got '${value}'.`;
  }
  if (f <= 0) {
    return `${name} must be a positive number, got '${value}'.`;
  }
  return null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(value: string): string | null {
  if (!UUID_PATTERN.test(value)) {
    return (
      `Invalid order ID format: '${value}'. ` +
      "Expected a UUID like '12345678-1234-1234-1234-123456789abc'. " +
      "Use 'get_active_orders' to find your order IDs."
    );
  }
  return null;
}

export const VALID_RESOLUTIONS = new Set([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "2d",
  "4d",
  "1w",
  "2w",
  "4w",
]);

export const CHUNK_MS = 7 * 24 * 60 * 60 * 1000;

const RESOLUTION_MINUTES: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "2d": 2880,
  "4d": 5760,
  "1w": 10080,
  "2w": 20160,
  "4w": 40320,
};

const CANDLES_PER_CHUNK = 1000;

export function candleChunkMs(resolution: string): number {
  const minutes = RESOLUTION_MINUTES[resolution] ?? 60;
  return CANDLES_PER_CHUNK * minutes * 60 * 1000;
}

export async function fetchAllCandlesChunked<T>(
  fetchPage: (startDate: number, endDate: number) => Promise<{ data: T[] }>,
  startDate: number,
  endDate: number,
  chunkMs: number,
): Promise<T[]> {
  const all: T[] = [];
  let chunkStart = startDate;
  while (chunkStart < endDate) {
    const chunkEnd = Math.min(chunkStart + chunkMs, endDate);
    const result = await fetchPage(chunkStart, chunkEnd);
    all.push(...result.data);
    chunkStart = chunkEnd;
  }
  return all;
}

export async function fetchAllChunked<T>(
  fetchPage: (
    startDate: number,
    endDate: number,
    cursor?: string,
  ) => Promise<{ data: T[]; metadata: { next_cursor?: string } }>,
  startDate: number,
  endDate: number,
): Promise<T[]> {
  const all: T[] = [];
  let chunkStart = startDate;
  while (chunkStart < endDate) {
    const chunkEnd = Math.min(chunkStart + CHUNK_MS, endDate);
    let cursor: string | undefined;
    do {
      const result = await fetchPage(chunkStart, chunkEnd, cursor);
      all.push(...result.data);
      cursor = result.metadata.next_cursor;
    } while (cursor);
    chunkStart = chunkEnd;
  }
  return all;
}

export async function handleApiError(
  error: unknown,
  setupGuide: string,
): Promise<ReturnType<typeof textResult> | null> {
  const { AuthNotConfiguredError, RateLimitError, ServerError } =
    await import("revolutx-api");
  if (error instanceof AuthNotConfiguredError) return textResult(setupGuide);
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

export const CLI_INSTALL_HINT =
  "\n\n" +
  "[IMPORTANT — ASSISTANT INSTRUCTION]\n" +
  "The first time you show a `revx` CLI command in this conversation, you MUST include the install instructions below.\n" +
  "If you have already shown install instructions earlier in this conversation, you may skip this.\n\n" +
  "```\n" +
  "# Install the revx CLI (requires Node.js 18+)\n" +
  "git clone https://github.com/revolut-engineering/revolut-x-api.git\n" +
  "cd revolut-x-api/api && npm install && npm run build\n" +
  "cd ../cli && npm install && npm run build && npm link\n" +
  "```";
