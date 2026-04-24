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

const RELATIVE_DATE_PATTERN = /^(\d+)(m|h|d)$/;
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
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return {
      error:
        `Invalid date format: '${value}'. ` +
        "Use ISO 8601 (e.g. '2024-01-15') or relative (e.g. '1h', '30m', '7d').",
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
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
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
