export class RevolutXError extends Error {
  readonly statusCode: number | undefined;
  constructor(message: string, statusCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "RevolutXError";
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends RevolutXError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 401, options);
    this.name = "AuthenticationError";
  }
}

export class ForbiddenError extends RevolutXError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 403, options);
    this.name = "ForbiddenError";
  }
}

export class RateLimitError extends RevolutXError {
  readonly retryAfter?: number;

  constructor(
    message: string = "Rate limit exceeded",
    retryAfter?: number,
    options?: ErrorOptions,
  ) {
    super(message, 429, options);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class BadRequestError extends RevolutXError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends RevolutXError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 404, options);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends RevolutXError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 409, options);
    this.name = "ConflictError";
  }
}

export class ServerError extends RevolutXError {
  constructor(message: string, statusCode: number, options?: ErrorOptions) {
    super(message, statusCode, options);
    this.name = "ServerError";
  }
}

export class NetworkError extends RevolutXError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, undefined, options);
    this.name = "NetworkError";
  }
}

export class AuthNotConfiguredError extends RevolutXError {
  constructor(
    message: string = "Revolut X credentials not configured. Run: revx configure",
    options?: ErrorOptions,
  ) {
    super(message, undefined, options);
    this.name = "AuthNotConfiguredError";
  }
}

export class InsecureKeyPermissionsError extends RevolutXError {
  readonly path?: string;

  constructor(message: string, path?: string, options?: ErrorOptions) {
    super(message, undefined, options);
    this.name = "InsecureKeyPermissionsError";
    this.path = path;
  }
}

export class ValidationError extends RevolutXError {
  constructor(
    message: string,
    public readonly errors?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, 400, options);
    this.name = "ValidationError";
  }
}
