import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { Decimal } from "decimal.js";
import { registerStrategyCommand } from "../../src/commands/strategy.js";

const botCapture = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../../src/engine/grid-bot.js", () => ({
  ForegroundGridBot: class {
    private readonly _options: Record<string, unknown>;

    constructor(
      _config: Record<string, unknown>,
      options: Record<string, unknown>,
    ) {
      this._options = options;
      botCapture.options = options;
    }

    async run(): Promise<void> {
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

    stop(): void {}

    async shutdown(): Promise<void> {}
  },
}));

describe("strategy run machine output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    botCapture.options = undefined;
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
});
