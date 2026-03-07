export class RevolutXError extends Error {
  readonly statusCode: number | undefined;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "RevolutXError";
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends RevolutXError {
  constructor(message: string) {
    super(message, 401);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends RevolutXError {
  constructor(message: string = "Rate limit exceeded") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

export class OrderError extends RevolutXError {
  constructor(message: string) {
    super(message, 400);
    this.name = "OrderError";
  }
}

export class NotFoundError extends RevolutXError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends RevolutXError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

export class NetworkError extends RevolutXError {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export class AuthNotConfiguredError extends RevolutXError {
  constructor(
    message: string = "Revolut X credentials not configured. Run: revx configure",
  ) {
    super(message);
    this.name = "AuthNotConfiguredError";
  }
}
