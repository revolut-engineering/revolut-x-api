import type { KeyObject } from "node:crypto";
import { buildAuthHeaders } from "../auth/signer.js";
import type { Logger } from "../logging/logger.js";
import {
  RevolutXError,
  AuthenticationError,
  ForbiddenError,
  RateLimitError,
  OrderError,
  NotFoundError,
  ConflictError,
  ServerError,
} from "./errors.js";

export interface RequestOptions {
  baseUrl: string;
  apiKey?: string;
  privateKey?: KeyObject;
  timeout: number;
  maxRetries: number;
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
      throw new OrderError(message);
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

  if (options.apiKey && options.privateKey) {
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

  let lastError: Error | undefined;

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

      if (options.apiKey && options.privateKey) {
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
      return JSON.parse(text);
    } catch (error) {
      options.logger.warn("Request failed", {
        attempt,
        path: fullPath,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!(error instanceof ServerError)) {
        throw error;
      }

      lastError = error;
    }
  }

  options.logger.error("Request failed after all retries", {
    path: fullPath,
    maxRetries: options.maxRetries,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError!;
}
