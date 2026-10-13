import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerStrategyCommand } from "../../src/commands/strategy.js";

const bot = vi.hoisted(() => ({
  run: vi.fn(() => new Promise<void>(() => {})),
  stop: vi.fn(),
  shutdown: vi.fn(async () => {}),
}));

vi.mock("../../src/util/client.js", () => ({ getClient: vi.fn(() => ({})) }));

vi.mock("../../src/db/grid-lock.js", () => ({
  acquireGridLock: vi.fn(async () => ({ release: vi.fn() })),
}));

vi.mock("../../src/engine/grid-bot.js", () => ({
  ForegroundGridBot: vi.fn(() => bot),
}));

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

describe("grid run stop signals", () => {
  let before: Map<string, ReturnType<typeof process.listeners>>;

  beforeEach(() => {
    vi.clearAllMocks();
    before = new Map(
      SIGNALS.map((signal) => [signal, process.listeners(signal)]),
    );
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal)!.includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
    vi.restoreAllMocks();
  });

  async function runningGrid(): Promise<void> {
    const program = new Command().exitOverride();
    registerStrategyCommand(program);
    void program.parseAsync([
      "node",
      "revx",
      "strategy",
      "grid",
      "run",
      "BTC-USD",
      "--investment",
      "100",
    ]);
    await vi.waitFor(() => expect(bot.run).toHaveBeenCalled());
  }

  function send(signal: (typeof SIGNALS)[number]): void {
    const added = process
      .listeners(signal)
      .filter((listener) => !before.get(signal)!.includes(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
  }

  it("ends the grid on Ctrl+C", async () => {
    // given
    await runningGrid();

    // when
    send("SIGINT");

    // then
    await vi.waitFor(() => expect(bot.shutdown).toHaveBeenCalledWith("end"));
  });

  it("keeps the grid when the system stops it", async () => {
    // given
    await runningGrid();

    // when
    send("SIGTERM");

    // then
    await vi.waitFor(() => expect(bot.shutdown).toHaveBeenCalledWith("pause"));
  });
});
