import type { KeyObject } from "node:crypto";
import { buildAuthHeaders } from "../auth/signer.js";
import { assertKeyStillSecure } from "../config/settings.js";
import type { Logger } from "../logging/logger.js";
import {
  RevolutXError,
  AuthenticationError,
  ForbiddenError,
  RateLimitError,
  BadRequestError,
  NotFoundError,
  ConflictError,
  ServerError,
  NetworkError,
  InsecureKeyPermissionsError,
  isDuplicateClientOrderIdError,
} from "./errors.js";

export interface RequestOptions {
  baseUrl: string;
  apiKey?: string;
  privateKey?: KeyObject;
  privateKeyPath?: string;
  enforceKeyPermissions?: boolean;
  timeout: number;
  maxRetries: number;
  generatedBy?: string;
  logger: Logger;
}

function buildQueryString(params: Record<string, unknown>): string {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    entries.push([key, String(value)]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function applyAuthHeaders(
  options: RequestOptions,
  headers: Record<string, string>,
  method: string,
  fullPath: string,
  queryString: string,
  bodyString: string,
): void {
  if (!options.apiKey || !options.privateKey) return;
  if (options.enforceKeyPermissions) {
    if (!options.privateKeyPath) {
      throw new InsecureKeyPermissionsError(
        "enforceKeyPermissions is set but no privateKeyPath is available",
      );
    }
    assertKeyStillSecure(options.privateKeyPath, "private key");
  }
  const authHeaders = buildAuthHeaders(
    options.apiKey,
    options.privateKey,
    method,
    fullPath,
    queryString,
    bodyString,
  );
  Object.assign(headers, authHeaders);
}

async function raiseForStatus(response: Response): Promise<void> {
  if (response.ok) return;

  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {}

  switch (response.status) {
    case 401:
      throw new AuthenticationError(message);
    case 403:
      throw new ForbiddenError(message);
    case 429: {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfter = retryAfterHeader
        ? Number(retryAfterHeader)
        : undefined;
      throw new RateLimitError(message, retryAfter);
    }
    case 400:
      throw new BadRequestError(message);
    case 404:
      throw new NotFoundError(message);
    case 409:
      throw new ConflictError(message);
    default:
      if (response.status >= 500)
        throw new ServerError(message, response.status);
      throw new RevolutXError(message, response.status);
  }
}

const UNSENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
  "ERR_SSL_UNSUPPORTED_PROTOCOL",
  "ERR_SSL_NO_PROTOCOLS_AVAILABLE",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
]);
const UNSENT_WHILE_CONNECTING = new Set([
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);
const UNSENT_MESSAGES = new Set(["bad port"]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function failedWhileConnecting(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every((inner) => failedWhileConnecting(inner))
    );
  }
  return (error as { syscall?: unknown } | null)?.syscall === "connect";
}

function isUnsent(
  code: string | undefined,
  cause: unknown,
  message: string,
): boolean {
  if (UNSENT_MESSAGES.has(message)) return true;
  if (code === undefined) return false;
  if (UNSENT_ERROR_CODES.has(code)) return true;
  return UNSENT_WHILE_CONNECTING.has(code) && failedWhileConnecting(cause);
}

function withPeriod(text: string): string {
  return `${text.replace(/\.+$/, "")}.`;
}

export function toNetworkError(
  error: unknown,
  timeoutMs: number,
  afterServerError = false,
): NetworkError | null {
  if (error instanceof RevolutXError) return null;
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new NetworkError(
      afterServerError
        ? `The exchange answered with a server error, and the retry got no reply within ${timeoutMs / 1000} s.`
        : `No reply from the exchange within ${timeoutMs / 1000} s.`,
      { cause: error, mayHaveReachedServer: true },
    );
  }
  const cause = (error as Error | undefined)?.cause;
  const code = errorCode(error) ?? errorCode(cause);
  const fetchFailed =
    error instanceof TypeError && error.message === "fetch failed";
  if (code === undefined && !fetchFailed) return null;
  const causeMessage = cause instanceof Error ? cause.message : "";
  const reason = code ?? (causeMessage || "fetch failed");
  if (afterServerError) {
    return new NetworkError(
      `The exchange answered with a server error, and the retry failed: ${reason}.`,
      { cause: error, mayHaveReachedServer: true },
    );
  }
  const unsent = isUnsent(code, errorCode(error) ? error : cause, causeMessage);
  return new NetworkError(
    unsent
      ? `Could not reach the exchange: ${reason}.`
      : `No reply from the exchange: ${reason}.`,
    { cause: error, mayHaveReachedServer: !unsent },
  );
}

function parseReply(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new NetworkError(
      withPeriod(
        `The exchange's reply couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { cause: error, mayHaveReachedServer: true },
    );
  }
}

export async function makeRequest(
  options: RequestOptions,
  method: string,
  path: string,
  params?: Record<string, unknown>,
  jsonBody?: Record<string, unknown>,
): Promise<unknown> {
  const queryString = params ? buildQueryString(params) : "";
  const bodyString = jsonBody ? JSON.stringify(jsonBody) : "";
  const fullPath = `/api/1.0${path}`;
  const url = `${options.baseUrl}${fullPath}${queryString ? `?${queryString}` : ""}`;

  options.logger.debug("Making API request", {
    method,
    path: fullPath,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (options.generatedBy) {
    headers["X-GENERATED-BY"] = options.generatedBy;
  }

  applyAuthHeaders(options, headers, method, fullPath, queryString, bodyString);

  let lastError: ServerError | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.pow(2, attempt) * 500 + Math.random() * 500;
      options.logger.info("Retrying request", {
        attempt,
        maxRetries: options.maxRetries,
        delayMs,
        path: fullPath,
      });
      await new Promise((r) => setTimeout(r, delayMs));

      applyAuthHeaders(
        options,
        headers,
        method,
        fullPath,
        queryString,
        bodyString,
      );
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: bodyString || undefined,
        signal: AbortSignal.timeout(options.timeout),
      });

      await raiseForStatus(response);

      if (response.status === 204) {
        options.logger.debug("Request completed", {
          status: 204,
          path: fullPath,
        });
        return {};
      }

      const text = await response.text();
      if (!text) return {};
      options.logger.debug("Request completed", {
        status: response.status,
        path: fullPath,
      });
      return parseReply(text);
    } catch (error) {
      options.logger.warn("Request failed", {
        attempt,
        path: fullPath,
        error: error instanceof Error ? error.message : String(error),
      });

      const changesState = method !== "GET";
      const networkError = toNetworkError(
        error,
        options.timeout,
        changesState && lastError !== undefined,
      );
      if (networkError) throw networkError;
      if (error instanceof ServerError) {
        lastError = error;
        continue;
      }
      if (changesState && lastError !== undefined) {
        if (isDuplicateClientOrderIdError(error)) {
          throw new BadRequestError((error as BadRequestError).message, {
            cause: lastError,
          });
        }
        throw new ServerError(lastError.message, lastError.statusCode ?? 500, {
          cause: error,
        });
      }
      throw error;
    }
  }

  options.logger.error("Request failed after all retries", {
    path: fullPath,
    maxRetries: options.maxRetries,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError!;
}
