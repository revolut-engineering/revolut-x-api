import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  emitGridBotTracePlain,
  formatBacktestFills,
} from "../src/output/trace.js";
import { ForegroundGridBot } from "../src/engine/grid-bot.js";
import type { BacktestFill } from "../src/shared/backtest/index.js";

function captureOutput(): { output: () => string; stream: Writable } {
  let value = "";
  return {
    output: () => value,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
  };
}

describe("plain trace fill summaries", () => {
  it("summarizes large grid bot fill batches from both ends", () => {
    // given
    const capture = captureOutput();
    const fills = Array.from({ length: 10 }, (_, index) => `FILL-${index + 1}`);

    // when
    emitGridBotTracePlain(
      {
        index: 1,
        timestamp: 1,
        price: new Decimal("65000"),
        fills,
        position: new Decimal(0),
        realizedPnl: new Decimal(0),
        unrealizedPnl: new Decimal(0),
        openOrders: 100,
      },
      "$",
      capture.stream,
    );
    const output = stripVTControlCharacters(capture.output());

    // then
    expect(output).toContain("FILL-1; FILL-2; … +6 more; FILL-9; FILL-10");
    expect(output).not.toContain("FILL-3");
    expect(output).not.toContain("FILL-8");
  });

  it("summarizes large backtest fill batches from both ends", () => {
    // given
    const fills: BacktestFill[] = Array.from({ length: 10 }, (_, index) => ({
      side: "buy",
      price: new Decimal(index + 1),
      quantity: new Decimal(1),
      quoteValue: new Decimal(1),
      trigger: "grid",
    }));

    // when
    const output = formatBacktestFills(fills);

    // then
    expect(output).toBe("BUY 1@1; BUY 1@2; … +6 more; BUY 1@9; BUY 1@10");
  });
});

describe("grid bot human output", () => {
  it("writes human messages to the configured stream", () => {
    // given
    const capture = captureOutput();
    const bot = new ForegroundGridBot(
      {
        pair: "BTC-USD",
        levels: 2,
        rangePct: "0.1",
        investment: "100",
        splitInvestment: false,
        intervalSec: 5,
        dryRun: true,
        reset: false,
        trailingUp: false,
      },
      { humanOutput: capture.stream },
    );
    const internals = bot as unknown as {
      _log: (message: string) => void;
    };

    // when
    internals._log("progress");

    // then
    expect(capture.output()).toBe("progress\n");
  });
});
