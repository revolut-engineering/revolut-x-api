import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { Decimal } from "decimal.js";
import { registerStrategyCommand } from "../../src/commands/strategy.js";

const botCapture = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  config: undefined as Record<string, unknown> | undefined,
  construct: undefined as undefined | (() => void),
  run: undefined as undefined | (() => Promise<void>),
  shutdown: vi.fn(async () => {}),
  stop: vi.fn(),
}));

const lockCapture = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));

const clientCapture = vi.hoisted(() => ({
  getClient: vi.fn(),
}));

vi.mock("../../src/util/client.js", () => ({
  getClient: clientCapture.getClient,
}));

vi.mock("../../src/db/grid-lock.js", () => ({
  acquireGridLock: async (pair: string) => {
    lockCapture.acquire(pair);
    return { release: lockCapture.release };
  },
}));

vi.mock("../../src/engine/grid-bot.js", () => ({
  ForegroundGridBot: class {
    private readonly _options: Record<string, unknown>;

    constructor(
      _config: Record<string, unknown>,
      options: Record<string, unknown>,
    ) {
      botCapture.construct?.();
      botCapture.config = _config;
      this._options = options;
      botCapture.options = options;
    }

    async run(): Promise<void> {
      if (botCapture.run) return botCapture.run();
      const onTick = this._options.onTick as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      onTick?.({
        index: 1,
        timestamp: 1,
        price: new Decimal("100"),
        fills: [],
        position: new Decimal(0),
        realizedPnl: new Decimal(0),
        unrealizedPnl: new Decimal(0),
        openOrders: 1,
      });
    }

    stop(): void {
      botCapture.stop();
    }

    shutdown(): Promise<void> {
      return botCapture.shutdown();
    }
  },
}));

describe("strategy run machine output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    botCapture.options = undefined;
    botCapture.construct = undefined;
    botCapture.run = undefined;
    botCapture.shutdown.mockReset();
    botCapture.shutdown.mockImplementation(async () => {});
    botCapture.stop.mockReset();
    clientCapture.getClient.mockReset();
    lockCapture.acquire.mockReset();
    lockCapture.release.mockReset();
  });

  function runArgs(...extra: string[]) {
    return [
      "node",
      "revx",
      "strategy",
      "grid",
      "run",
      "BTC-USD",
      "--levels",
      "1",
      "--range",
      "10",
      "--investment",
      "100",
      ...extra,
    ];
  }

  it("holds the grid lock while the run lasts and releases it at the end", async () => {
    // given
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync(runArgs("--dry-run"));

    // then
    expect(lockCapture.acquire).toHaveBeenCalledWith("BTC-USD");
    expect(lockCapture.release).toHaveBeenCalledOnce();
    expect(lockCapture.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      lockCapture.release.mock.invocationCallOrder[0],
    );
  });

  it("refuses to start while the same grid is running and starts no bot", async () => {
    // given
    lockCapture.acquire.mockImplementation(() => {
      throw new Error("Grid BTC-USD is already running (process 4242).");
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(runArgs("--dry-run"));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain(
      "Grid BTC-USD is already running (process 4242).",
    );
    expect(botCapture.options).toBeUndefined();
    expect(lockCapture.release).not.toHaveBeenCalled();
  });

  it("routes bot progress to stderr in JSON trace mode", async () => {
    // given
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync([
      "node",
      "revx",
      "strategy",
      "grid",
      "run",
      "BTC-USD",
      "--levels",
      "1",
      "--range",
      "10",
      "--investment",
      "100",
      "--dry-run",
      "--trace",
      "--json",
    ]);

    // then
    expect(botCapture.options?.humanOutput).toBe(process.stderr);
    expect(botCapture.options?.suppressDashboard).toBe(true);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  function captureSignals() {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: () => void,
    ) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "off").mockImplementation(
      (() => process) as typeof process.off,
    );
    return handlers;
  }

  async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("releases the lock only after a Ctrl+C shutdown has finished", async () => {
    // given
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const handlers = captureSignals();
    botCapture.run = () => new Promise(() => {});
    let finishShutdown = () => {};
    botCapture.shutdown.mockImplementation(
      () => new Promise<void>((resolve) => (finishShutdown = resolve)),
    );
    const program = new Command();
    registerStrategyCommand(program);
    void program.parseAsync(runArgs("--dry-run"));
    await settle();

    // when
    handlers.get("SIGINT")!();
    await settle();
    const releasedDuringShutdown = lockCapture.release.mock.calls.length;
    finishShutdown();
    await settle();

    // then
    expect(releasedDuringShutdown).toBe(0);
    expect(lockCapture.release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second Ctrl+C while the first shutdown runs", async () => {
    // given
    let written = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written += String(chunk);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as typeof process.exit,
    );
    const handlers = captureSignals();
    botCapture.run = () => new Promise(() => {});
    botCapture.shutdown.mockImplementation(() => new Promise(() => {}));
    const program = new Command();
    registerStrategyCommand(program);
    void program.parseAsync(runArgs("--dry-run"));
    await settle();

    // when
    handlers.get("SIGINT")!();
    handlers.get("SIGINT")!();
    await settle();

    // then
    expect(botCapture.shutdown).toHaveBeenCalledOnce();
    expect(written).toContain("Still shutting down.");
  });

  it("releases the lock and exits 1 when the run fails", async () => {
    // given
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    botCapture.run = async () => {
      throw new Error("Pair configuration not found");
    };
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(runArgs("--dry-run"));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(lockCapture.release).toHaveBeenCalled();
    expect(errors.join("\n")).toContain("Pair configuration not found");
  });

  it("gives the configure hint and releases the lock when the exchange refuses the key", async () => {
    // given
    const { AuthenticationError } = await import("@revolut/revolut-x-api");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    botCapture.run = async () => {
      throw new AuthenticationError("Unable to resolve API key");
    };
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(runArgs("--dry-run"));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(lockCapture.release).toHaveBeenCalled();
    expect(stripVTControlCharacters(errors.join("\n"))).toContain(
      "Run 'revx configure' to update your credentials.",
    );
  });

  it("releases the lock when the bot can't be created", async () => {
    // given
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    botCapture.construct = () => {
      throw new Error("bad config");
    };
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(runArgs("--dry-run"));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(lockCapture.release).toHaveBeenCalledOnce();
  });

  it("checks the credentials before it takes the grid lock", async () => {
    // given
    clientCapture.getClient.mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(runArgs("--dry-run"));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(clientCapture.getClient).toHaveBeenCalledWith({ requireAuth: true });
    expect(lockCapture.acquire).not.toHaveBeenCalled();
  });

  it("releases the lock and exits 1 when the Ctrl+C shutdown fails", async () => {
    // given
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const handlers = captureSignals();
    botCapture.run = () => new Promise(() => {});
    botCapture.shutdown.mockRejectedValue(new Error("save failed"));
    const program = new Command();
    registerStrategyCommand(program);
    void program.parseAsync(runArgs("--dry-run"));
    await settle();

    // when
    handlers.get("SIGINT")!();
    await settle();

    // then
    expect(lockCapture.release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("save failed");
  });

  it("keeps the lock and the signal handlers until a Ctrl+C shutdown ends, even if the run fails meanwhile", async () => {
    // given
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const handlers = captureSignals();
    let failRun: (err: Error) => void = () => {};
    botCapture.run = () =>
      new Promise<void>((_resolve, reject) => (failRun = reject));
    let finishShutdown = () => {};
    botCapture.shutdown.mockImplementation(
      () => new Promise<void>((resolve) => (finishShutdown = resolve)),
    );
    const program = new Command();
    registerStrategyCommand(program);
    const run = program.parseAsync(runArgs("--dry-run"));
    await settle();

    // when
    handlers.get("SIGINT")!();
    failRun(new Error("loop failed"));
    await run;
    const releasedBeforeShutdownEnds = lockCapture.release.mock.calls.length;
    const exitedBeforeShutdownEnds = exit.mock.calls.length;
    finishShutdown();
    await settle();

    // then
    expect(releasedBeforeShutdownEnds).toBe(0);
    expect(exitedBeforeShutdownEnds).toBe(0);
    expect(process.off).not.toHaveBeenCalled();
    expect(lockCapture.release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each(["4", "86401", "1.5", "ten"])(
    "refuses --interval %s before it takes the grid lock",
    async (interval) => {
      // given
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const program = new Command();
      registerStrategyCommand(program);

      // when
      const run = program.parseAsync(
        runArgs("--dry-run", "--interval", interval),
      );

      // then
      await expect(run).rejects.toThrow("process.exit");
      expect(errors.join("\n")).toContain("--interval must be");
      expect(lockCapture.acquire).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["5", 5],
    ["86400", 86_400],
  ])("accepts --interval %s", async (interval, seconds) => {
    // given
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command();
    registerStrategyCommand(program);

    // when
    await program.parseAsync(runArgs("--dry-run", "--interval", interval));

    // then
    expect(botCapture.config).toMatchObject({ intervalSec: seconds });
  });

  it("refuses --json for a live grid before it takes the lock", async () => {
    // given
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(runArgs("--json"));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(errors.join("\n")).toContain(
      "grid run has no JSON output. Read the grid's orders with: revx order open --json",
    );
    expect(errors.join("\n")).not.toMatch(/--trace|--prices/);
    expect(lockCapture.acquire).not.toHaveBeenCalled();
  });

  it("refuses --json for a dry run without pointing to real orders", async () => {
    // given
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = new Command();
    registerStrategyCommand(program);

    // when
    const run = program.parseAsync(runArgs("--dry-run", "--json"));

    // then
    await expect(run).rejects.toThrow("process.exit");
    expect(errors.join("\n")).toContain("grid run has no JSON output.");
    expect(errors.join("\n")).not.toContain("revx order open");
  });
});
