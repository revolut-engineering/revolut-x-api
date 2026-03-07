import type { KeyObject } from "node:crypto";
import { buildAuthHeaders } from "../auth/signer.js";
import { RateLimiter } from "./rate-limiter.js";
import {
  RevolutXError,
  AuthenticationError,
  RateLimitError,
  OrderError,
  NotFoundError,
  ConflictError,
  NetworkError,
} from "./errors.js";

export interface RequestOptions {
  baseUrl: string;
  apiKey?: string;
  privateKey?: KeyObject;
  rateLimiter: RateLimiter;
  timeout: number;
  maxRetries: number;
}

function buildQueryString(params: Record<string, unknown>): string {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    entries.push([key, String(value)]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
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
    case 403:
      throw new AuthenticationError(message);
    case 429:
      throw new RateLimitError(message);
    case 400:
      throw new OrderError(message);
    case 404:
      throw new NotFoundError(message);
    case 409:
      throw new ConflictError(message);
    default:
      throw new RevolutXError(message, response.status);
  }
}

export async function makeRequest(
  options: RequestOptions,
  method: string,
  path: string,
  params?: Record<string, unknown>,
  jsonBody?: Record<string, unknown>,
  isPublic: boolean = false,
): Promise<unknown> {
  const queryString = params ? buildQueryString(params) : "";
  const bodyString = jsonBody ? JSON.stringify(jsonBody) : "";
  const fullPath = `/api/1.0${path}`;
  const url = `${options.baseUrl}${fullPath}${queryString ? `?${queryString}` : ""}`;

  if (isPublic) {
    await options.rateLimiter.acquirePublic();
  } else {
    await options.rateLimiter.acquireGeneral();
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (!isPublic && options.apiKey && options.privateKey) {
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
      const delay = Math.pow(2, attempt) * 0.5 + Math.random() * 0.5;
      await new Promise((r) => setTimeout(r, delay * 1000));

      if (!isPublic && options.apiKey && options.privateKey) {
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

      if (response.status === 204) return {};

      const text = await response.text();
      if (!text) return {};
      return JSON.parse(text);
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof OrderError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }

      lastError = error instanceof Error ? error : new Error(String(error));

      if (
        error instanceof RateLimitError ||
        error instanceof ConflictError ||
        (error instanceof RevolutXError &&
          error.statusCode &&
          error.statusCode >= 500)
      ) {
        continue;
      }

      if (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        lastError = new NetworkError(error.message);
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new NetworkError("Request failed after retries");
}
