export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

export type LogCallback = (entry: LogEntry) => void;

export class Logger {
  constructor(private callback?: LogCallback) {}

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ) {
    if (!this.callback) return;
    this.callback({
      level,
      message,
      timestamp: Date.now(),
      context,
    });
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.log("error", message, context);
  }
}
