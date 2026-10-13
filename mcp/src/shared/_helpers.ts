import { dirname } from "node:path";
import type { CredentialsIssue } from "@revolut/revolut-x-api";
import { VALID_RESOLUTIONS } from "./common.js";

const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

export interface ToolText {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function textResult(text: string): ToolText {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(text: string): ToolText {
  return { content: [{ type: "text" as const, text }], isError: true };
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

export const API_URL_ADVICE =
  "Ask the user to correct the API URL setting, or to clear it to use https://revx.revolut.com.";

export async function credentialsAdvice(
  issue: CredentialsIssue,
  setupGuide: string,
): Promise<string> {
  const { redactHome } = await import("@revolut/revolut-x-api");
  const path = redactHome(issue.path);
  switch (issue.fault) {
    case "unreadable":
      return issue.code === "EACCES" || issue.code === "EPERM"
        ? `${issue.problem} Ask the user to make sure the file and its folder belong to them and they can read them, for example: chmod 700 ${redactHome(dirname(issue.path))} and chmod 600 ${path}. Then run 'check_auth_status'.`
        : `${issue.problem} Ask the user to check ${path} and fix what stops it from being read, such as a broken link. Then run 'check_auth_status'.`;
    case "not_a_file":
      return `${issue.problem} Ask the user to move the folder ${path} out of the way. Then run 'check_auth_status'.`;
    case "missing":
      return `${issue.problem} If the user has a copy of the key, ask them to put it back at ${path}. Otherwise:\n\n${setupGuide}`;
    case "malformed":
      return issue.file === "config"
        ? `${issue.problem} Run 'configure_api_key' with the user's API key to write a new config file.`
        : `${issue.problem} 'generate_keypair' moves this key aside and makes a new one.\n\n${setupGuide}`;
  }
}

export async function handleApiError(
  error: unknown,
  setupGuide: string,
): Promise<ToolText | null> {
  const {
    AuthNotConfiguredError,
    ConfigurationError,
    InvalidCredentialsError,
    InsecureKeyPermissionsError,
    RateLimitError,
    ServerError,
    ForbiddenError,
    AuthenticationError,
    getConfigFile,
  } = await import("@revolut/revolut-x-api");
  if (error instanceof ConfigurationError) {
    return errorResult(`${error.message} ${API_URL_ADVICE}`);
  }
  if (error instanceof InvalidCredentialsError) {
    return errorResult(await credentialsAdvice(error.issue, setupGuide));
  }
  if (error instanceof AuthNotConfiguredError) return errorResult(setupGuide);
  if (
    error instanceof InsecureKeyPermissionsError &&
    error.path === getConfigFile()
  ) {
    return errorResult(
      `${error.message}\n\nThe config file holds the API key, not the private key, so no new key pair is needed. Ask the user to run the chmod command above, then run 'check_auth_status'.`,
    );
  }
  if (error instanceof InsecureKeyPermissionsError) {
    const steps = [
      "1. Go to Revolut X → Profile → API Keys and DELETE the current API key (the private key file may have been exposed while permissions were loose).",
      "2. Run the 'generate_keypair' tool to create a fresh Ed25519 keypair.",
      "3. Add the new public key to Revolut X and create a new API key — tick the 'Allow usage via Revolut X MCP and CLI' checkbox.",
      "4. Run 'configure_api_key' with the new key.",
      "5. Run 'check_auth_status' to verify.",
    ];
    return errorResult(
      "Credential file permissions are unsafe — refusing to sign with this key.\n\n" +
        `${error.message}\n\n` +
        "Because the file was readable beyond the owner (or missing entirely), assume the private key may have leaked. Treat the key as compromised:\n\n" +
        `${steps.join("\n")}`,
    );
  }
  if (error instanceof AuthenticationError) {
    return errorResult(
      `The exchange refused the credentials: ${error.message}\n\nAsk the user to check that the API key is correct and that its public key is registered in their Revolut X profile. Then run 'check_auth_status'.`,
    );
  }
  if (error instanceof ForbiddenError) {
    const suggestions = [
      "• Go to Revolut X → Profile → Add public key",
      "• Check your API scopes to ensure you have the correct permissions",
      "• Ensure the 'Allow usage via Revolut X MCP and CLI' checkbox is ticked on your API key",
    ];
    return errorResult(
      `Access Forbidden\n\nHow to fix this:\n${suggestions.join("\n")}`,
    );
  }
  if (error instanceof RateLimitError) {
    const retry = error.retryAfter ? ` Retry after ${error.retryAfter}ms.` : "";
    return errorResult(`Rate limit exceeded.${retry}`);
  }
  if (error instanceof ServerError) {
    const e = error as InstanceType<typeof ServerError>;
    return errorResult(`Exchange server error (${e.statusCode}): ${e.message}`);
  }
  return null;
}

export function validateResolution(resolution: string): ToolText | null {
  if (!VALID_RESOLUTIONS.has(resolution)) {
    return errorResult(
      `Invalid resolution '${resolution}'. ` +
        `Use one of: ${[...VALID_RESOLUTIONS].sort().join(", ")}`,
    );
  }
  return null;
}

const RELATIVE_DATE_PATTERN = /^(\d+)([mhdw])$/;
const RELATIVE_UNITS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

function parseRelativeDate(value: string): number | null {
  const match = RELATIVE_DATE_PATTERN.exec(value.trim().toLowerCase());
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unitMs = RELATIVE_UNITS[match[2]];
  return Date.now() - amount * unitMs;
}

function beforeEpoch(value: string): { error: string } {
  return { error: `Invalid date: '${value}'. That is before 1970.` };
}

const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

function parseDate(value: string): number | { error: string } {
  const relative = parseRelativeDate(value);
  if (relative !== null) {
    return Number.isSafeInteger(relative) && relative >= 0
      ? relative
      : beforeEpoch(value);
  }
  const invalid = {
    error:
      `Invalid date format: '${value}'. ` +
      "Use a local date (e.g. '2024-01-15'), local date-time (e.g. '2024-01-15T14:30'), or relative (e.g. '1h', '30m', '7d').",
  };
  const parts = DATE_TIME_PATTERN.exec(value.trim());
  if (!parts) return invalid;
  const [, y, mo, d, h, mi = "00", sec = "00", fraction = "", zone] = parts;
  const [year, month, day, hours, minutes, seconds] = [
    y,
    mo,
    d,
    h ?? "0",
    mi,
    sec,
  ].map(Number);
  const check = new Date(
    Date.UTC(year, month - 1, day, hours, minutes, seconds),
  );
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hours ||
    check.getUTCMinutes() !== minutes ||
    check.getUTCSeconds() !== seconds
  ) {
    return invalid;
  }
  const millis = fraction.slice(0, 3).padEnd(3, "0");
  if (!zone) {
    const local = new Date(
      year,
      month - 1,
      day,
      hours,
      minutes,
      seconds,
      Number(millis),
    );
    if (
      h !== undefined &&
      (local.getDate() !== day ||
        local.getHours() !== hours ||
        local.getMinutes() !== minutes)
    ) {
      return {
        error: `Invalid date: '${value}'. That local time doesn't exist, because the clock changes then.`,
      };
    }
    return local.getTime() < 0 ? beforeEpoch(value) : local.getTime();
  }
  const offset =
    zone.toUpperCase() === "Z" ? "Z" : zone.replace(/^([+-]\d{2}):?/, "$1:");
  const instant = Date.parse(
    `${y}-${mo}-${d}T${h}:${mi}:${sec}.${millis}${offset}`,
  );
  if (Number.isNaN(instant)) return invalid;
  return instant < 0 ? beforeEpoch(value) : instant;
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
      return { error: errorResult(`Error: ${startResult.error}`) };
    parsedStartDate = startResult;
  }

  let parsedEndDate: number | undefined;
  if (end_date) {
    const endResult = parseDate(end_date);
    if (typeof endResult === "object")
      return { error: errorResult(`Error: ${endResult.error}`) };
    parsedEndDate = endResult;
  }

  const now = Date.now();
  const resolvedEndDate = Math.min(
    parsedEndDate ??
      (parsedStartDate !== undefined && !options?.endDefaultsToNow
        ? parsedStartDate + defaultWindowMs
        : now),
    now,
  );
  let resolvedStartDate = parsedStartDate ?? resolvedEndDate - defaultWindowMs;

  if (
    parsedStartDate !== undefined &&
    parsedEndDate !== undefined &&
    parsedStartDate > parsedEndDate
  ) {
    return {
      error: errorResult("Error: start_date must be before end_date."),
    };
  }
  if (resolvedStartDate > resolvedEndDate) {
    return { error: errorResult("Error: start_date is in the future.") };
  }

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
