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

export async function handleApiError(
  error: unknown,
  setupGuide: string,
): Promise<ReturnType<typeof textResult> | null> {
  const { AuthNotConfiguredError, RateLimitError, ServerError } =
    await import("api-k9x2a");
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

export const REQUIRE_COMPLETE_DATA_HINT =
  "Always return complete objects with all available fields. Never truncate, summarize, or omit data.";
export const LARGE_DATASET_HINT =
  "If the dataset exceeds 100 items, display only the first 100. Clearly state the total item count (e.g., 'Showing 100 of X items') and ask the user if they would like to view the next batch, see all results, or refine their query.";

export function formatDescription(
  baseDescription: string,
  instructions: string[] = [],
) {
  if (!instructions || instructions.length === 0) return baseDescription;

  const instructionsFormatted = instructions
    .map((instruction) => `- ${instruction}`)
    .join("\n");
  return `${baseDescription}\n\nIMPORTANT INSTRUCTIONS:\n${instructionsFormatted}`;
}
