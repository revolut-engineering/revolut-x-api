import { VALID_RESOLUTIONS } from "./common.js";

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

export function parseDateRange(
  start_date: string | undefined,
  end_date: string | undefined,
):
  | { error: ReturnType<typeof textResult> }
  | { parsedStartDate: number | undefined; parsedEndDate: number | undefined } {
  let parsedStartDate: number | undefined = undefined;
  if (start_date) {
    const ds = new Date(start_date);
    if (isNaN(ds.getTime())) {
      return {
        error: textResult(
          "Error: Invalid start_date format provided. Please use ISO 8601 format like 'YYYY-MM-DD'.",
        ),
      };
    }
    parsedStartDate = ds.getTime();
  }

  let parsedEndDate: number | undefined = undefined;
  if (end_date) {
    const de = new Date(end_date);
    if (isNaN(de.getTime())) {
      return {
        error: textResult(
          "Error: Invalid end_date format provided. Please use ISO 8601 format like 'YYYY-MM-DD'.",
        ),
      };
    }
    parsedEndDate = de.getTime();
  }

  return { parsedStartDate, parsedEndDate };
}

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
