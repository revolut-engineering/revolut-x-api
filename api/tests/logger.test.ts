import { describe, it, expect, vi } from "vitest";
import { Logger, type LogEntry } from "../src/logging/logger.js";

describe("Logger", () => {
  it("calls callback when logging", () => {
    const callback = vi.fn();
    const logger = new Logger(callback);

    logger.info("Test message", { key: "value" });

    expect(callback).toHaveBeenCalledOnce();
    const logEntry = callback.mock.calls[0][0] as LogEntry;
    expect(logEntry.level).toBe("info");
    expect(logEntry.message).toBe("Test message");
    expect(logEntry.context).toEqual({ key: "value" });
    expect(logEntry.timestamp).toBeTypeOf("number");
  });

  it("does not call callback when logger not configured", () => {
    const logger = new Logger();
    expect(() => logger.info("Test")).not.toThrow();
  });

  it("logs debug messages", () => {
    const callback = vi.fn();
    const logger = new Logger(callback);

    logger.debug("Debug message");

    const logEntry = callback.mock.calls[0][0] as LogEntry;
    expect(logEntry.level).toBe("debug");
    expect(logEntry.message).toBe("Debug message");
  });

  it("logs warn messages", () => {
    const callback = vi.fn();
    const logger = new Logger(callback);

    logger.warn("Warning message");

    const logEntry = callback.mock.calls[0][0] as LogEntry;
    expect(logEntry.level).toBe("warn");
  });

  it("logs error messages", () => {
    const callback = vi.fn();
    const logger = new Logger(callback);

    logger.error("Error message");

    const logEntry = callback.mock.calls[0][0] as LogEntry;
    expect(logEntry.level).toBe("error");
  });

  it("logs without context", () => {
    const callback = vi.fn();
    const logger = new Logger(callback);

    logger.info("Simple message");

    const logEntry = callback.mock.calls[0][0] as LogEntry;
    expect(logEntry.context).toBeUndefined();
  });

  it("includes timestamp", () => {
    const callback = vi.fn();
    const logger = new Logger(callback);

    const before = Date.now();
    logger.info("Test");
    const after = Date.now();

    const logEntry = callback.mock.calls[0][0] as LogEntry;
    expect(logEntry.timestamp).toBeGreaterThanOrEqual(before);
    expect(logEntry.timestamp).toBeLessThanOrEqual(after);
  });
});
