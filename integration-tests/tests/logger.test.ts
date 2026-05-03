import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../src/eval-framework/logger.js";

describe("logger", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalLevel = process.env.EVAL_LOG_LEVEL;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (originalLevel === undefined) delete process.env.EVAL_LOG_LEVEL;
    else process.env.EVAL_LOG_LEVEL = originalLevel;
  });

  it("emits warn at default (info) level", () => {
    delete process.env.EVAL_LOG_LEVEL;
    logger.warn("danger");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("[eval]");
    expect(warnSpy.mock.calls[0][0]).toContain("danger");
  });

  it("emits info at default (info) level", () => {
    delete process.env.EVAL_LOG_LEVEL;
    logger.info("hello");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("hello");
  });

  it("does not emit debug at info level", () => {
    delete process.env.EVAL_LOG_LEVEL;
    logger.debug("noisy");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("emits debug at debug level", () => {
    process.env.EVAL_LOG_LEVEL = "debug";
    logger.debug("noisy");
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("emits nothing at silent level", () => {
    process.env.EVAL_LOG_LEVEL = "silent";
    logger.warn("danger");
    logger.info("hello");
    logger.debug("noisy");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("formats structured fields", () => {
    delete process.env.EVAL_LOG_LEVEL;
    logger.info("event", { runId: "abc", count: 3 });
    const message = String(logSpy.mock.calls[0][0]);
    expect(message).toContain("runId=abc");
    expect(message).toContain("count=3");
  });

  it("child logger appends prefix", () => {
    delete process.env.EVAL_LOG_LEVEL;
    const child = logger.child("trial");
    child.info("ran");
    expect(logSpy.mock.calls[0][0]).toContain("[trial]");
  });
});
