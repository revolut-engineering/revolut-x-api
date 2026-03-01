/**
 * User-safe API exceptions. Never leak secrets or internal paths.
 */

export class RevolutXAPIError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "RevolutXAPIError";
    this.statusCode = statusCode;
  }
}

/** 401/403 — API key invalid or signature mismatch. */
export class AuthenticationError extends RevolutXAPIError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = "AuthenticationError";
  }
}

/** 429 — rate limit exceeded. */
export class RateLimitError extends RevolutXAPIError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = "RateLimitError";
  }
}

/** Order-specific errors (validation, insufficient funds, etc.). */
export class OrderError extends RevolutXAPIError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = "OrderError";
  }
}

/** Connection/timeout errors. */
export class NetworkError extends RevolutXAPIError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = "NetworkError";
  }
}

/** Resource not found. */
export class NotFoundError extends RevolutXAPIError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode ?? 404);
    this.name = "NotFoundError";
  }
}

/** Worker circuit is open or connection refused. */
export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

/** Worker returned a non-2xx HTTP status (4xx errors, not retried). */
export class WorkerAPIError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "WorkerAPIError";
    this.statusCode = statusCode;
  }
}

/** Raised when auth is not configured. Contains user-friendly message. */
export class AuthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthNotConfiguredError";
  }
}
