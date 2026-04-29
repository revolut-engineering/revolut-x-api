interface ErrorJson {
  name: string;
  message: string;
  details?: Record<string, unknown>;
  cause?: ErrorJson;
}

export class EvalFrameworkError extends Error {
  readonly details: Record<string, unknown>;
  constructor(
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = new.target.name;
    this.details = details;
  }
  toJSON(): ErrorJson {
    return serializeError(this);
  }
}

export class EvalConfigError extends EvalFrameworkError {}
export class EmbedderError extends EvalFrameworkError {}
export class JudgeParseError extends EvalFrameworkError {}
export class SemanticAssertionError extends EvalFrameworkError {}
export class ReportCorruptError extends EvalFrameworkError {}

export function serializeError(err: unknown): ErrorJson {
  if (err instanceof EvalFrameworkError) {
    return {
      name: err.name,
      message: err.message,
      details: err.details,
      cause: err.cause !== undefined ? serializeError(err.cause) : undefined,
    };
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      cause: err.cause !== undefined ? serializeError(err.cause) : undefined,
    };
  }
  return { name: "Unknown", message: String(err) };
}
