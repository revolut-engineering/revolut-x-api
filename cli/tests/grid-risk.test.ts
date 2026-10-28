import { describe, it, expect, vi } from "vitest";
import { Decimal } from "decimal.js";
import { stripVTControlCharacters } from "node:util";
import {
  findFirstGeometricShiftAbovePrice,
  levelsPerSide,
  trailUpTriggerFromBounds,
  trailUpTriggerPrice,
} from "../src/engine/grid-math.js";
import {
  renderShutdownSummary,
  renderDashboard,
  renderReconciliationSummary,
  renderRiskLine,
  renderStartedMessage,
} from "../src/engine/grid-renderer.js";
import type { GridState, GridLevelState } from "../src/db/grid-store.js";

function makeLevels(prices: string[]): GridLevelState[] {
  return prices.map((price, index) => ({
    index,
    price,
    buyOrderIds: [],
    positions: [],
  }));
}

const LADDER = makeLevels([
  "95000",
  "96920.75",
  "98880.32",
  "100879.52",
  "102919.14",
  "105000",
]);

function makeState(overrides: Partial<GridState["config"]> = {}): GridState {
  return {
    id: "x",
    pair: "BTC-USD",
    version: 2,
    createdAt: "",
    updatedAt: "",
    config: {
      levels: 6,
      rangePct: "0.05",
      investment: "1000",
      splitInvestment: false,
      intervalSec: 10,
      dryRun: true,
      ...overrides,
    },
    splitExecuted: false,
    gridPrice: "100000",
    quotePrecision: "0.01",
    basePrecision: "0.00001",
    quotePerLevel: "166.66",
    levels: LADDER,
    stats: { totalBuys: 0, totalSells: 0, realizedPnl: "0", totalFees: "0" },
    tradeLog: [],
  };
}

const PRICE = new Decimal("100000");

describe("trailUpTriggerPrice", () => {
  it("matches the boundary-check formula for a 95k-105k ladder", () => {
    const trigger = trailUpTriggerPrice(LADDER);
    expect(trigger).not.toBeNull();
    expect(trigger!.toFixed(2)).toBe("109288.78");
  });

  it("sits above the top grid level", () => {
    const trigger = trailUpTriggerPrice(LADDER)!;
    expect(trigger.gt(new Decimal("105000"))).toBe(true);
  });

  it("returns null for a ladder with fewer than two levels", () => {
    expect(trailUpTriggerPrice([])).toBeNull();
    expect(trailUpTriggerPrice(makeLevels(["95000"]))).toBeNull();
  });

  it("returns null when a boundary level is not positive", () => {
    expect(trailUpTriggerPrice(makeLevels(["0", "105000"]))).toBeNull();
    expect(trailUpTriggerPrice(makeLevels(["95000", "0"]))).toBeNull();
  });
});

describe("trailUpTriggerFromBounds", () => {
  const LOWER = new Decimal("95000");
  const UPPER = new Decimal("105000");

  it("agrees with the level-based adapter", () => {
    const fromBounds = trailUpTriggerFromBounds(LOWER, UPPER, 6);
    expect(fromBounds).not.toBeNull();
    expect(fromBounds!.eq(trailUpTriggerPrice(LADDER)!)).toBe(true);
  });

  it("returns null for fewer than two levels", () => {
    expect(trailUpTriggerFromBounds(LOWER, UPPER, 1)).toBeNull();
    expect(trailUpTriggerFromBounds(LOWER, UPPER, 0)).toBeNull();
  });

  it("returns null when either bound is not positive", () => {
    expect(trailUpTriggerFromBounds(new Decimal(0), UPPER, 6)).toBeNull();
    expect(trailUpTriggerFromBounds(LOWER, new Decimal(0), 6)).toBeNull();
    expect(trailUpTriggerFromBounds(new Decimal(-1), UPPER, 6)).toBeNull();
  });
});

describe("findFirstGeometricShiftAbovePrice", () => {
  it.each([
    { target: "105", minimumShift: 0, expected: 1 },
    { target: "50", minimumShift: 4, expected: 4 },
    { target: "120.99", minimumShift: 1, expected: 2 },
    { target: "121", minimumShift: 1, expected: 3 },
  ])(
    "returns shift $expected for target $target from minimum $minimumShift",
    ({ target, minimumShift, expected }) => {
      // when
      const shift = findFirstGeometricShiftAbovePrice(
        new Decimal("100"),
        new Decimal("1.1"),
        new Decimal(target),
        minimumShift,
      );

      // then
      expect(shift).toBe(expected);
    },
  );

  it("finds a 250001-step result with bounded exponent evaluations", () => {
    // given
    const boundaryPrice = new Decimal("100");
    const ratio = new Decimal("1.00001");
    const targetPrice = boundaryPrice.times(ratio.pow(250_000));
    const pow = vi.spyOn(Decimal.prototype, "pow");

    // when
    const shift = findFirstGeometricShiftAbovePrice(
      boundaryPrice,
      ratio,
      targetPrice,
      1,
    );

    // then
    expect(shift).toBe(250_001);
    expect(pow.mock.calls.length).toBeLessThan(64);
    pow.mockRestore();
  });

  it.each([
    { ratio: "1.001", target: "100.1", minimumShift: 0 },
    { ratio: "1.001", target: "150", minimumShift: 50 },
    { ratio: "1.01", target: "1000", minimumShift: 1 },
    { ratio: "1.1", target: "250", minimumShift: 8 },
  ])(
    "matches the historical search for ratio $ratio and target $target",
    ({ ratio, target, minimumShift }) => {
      // given
      const boundaryPrice = new Decimal("100");
      const gridRatio = new Decimal(ratio);
      const targetPrice = new Decimal(target);
      let historicalShift = minimumShift;
      while (
        boundaryPrice.times(gridRatio.pow(historicalShift)).lte(targetPrice)
      ) {
        historicalShift++;
      }

      // then
      expect(
        findFirstGeometricShiftAbovePrice(
          boundaryPrice,
          gridRatio,
          targetPrice,
          minimumShift,
        ),
      ).toBe(historicalShift);
    },
  );

  it("rejects a non-increasing ratio", () => {
    // then
    expect(() =>
      findFirstGeometricShiftAbovePrice(
        new Decimal("100"),
        new Decimal("1"),
        new Decimal("200"),
        1,
      ),
    ).toThrow(/ratio/i);
  });

  it("rejects an unsafe minimum shift", () => {
    // then
    expect(() =>
      findFirstGeometricShiftAbovePrice(
        new Decimal("100"),
        new Decimal("1.1"),
        new Decimal("200"),
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ).toThrow(/safe integer/i);
  });
});

describe("levelsPerSide", () => {
  it("halves the stored total, which the CLI builds as perSide * 2", () => {
    expect(levelsPerSide(6)).toBe(3);
    expect(levelsPerSide(10)).toBe(5);
    expect(levelsPerSide(2)).toBe(1);
  });
});

describe("renderStartedMessage", () => {
  it("reports the level count the user passed to --levels, not the stored total", () => {
    const state = makeState({ dryRun: false });
    expect(renderStartedMessage(state.pair, state.config)).toBe(
      "Grid Bot started: BTC-USD | 3 levels/side | \u00B15.0% | 1000 USD",
    );
  });

  it("tags dry-run mode", () => {
    const state = makeState();
    expect(renderStartedMessage(state.pair, state.config)).toBe(
      "Grid Bot started [DRY RUN]: BTC-USD | 3 levels/side | \u00B15.0% | 1000 USD",
    );
  });

  it("agrees with the level count the dashboard shows", () => {
    const state = makeState();
    const dash = renderDashboard({
      state,
      currentPrice: PRICE,
      uptime: 1000,
      tickCount: 1,
      lastError: null,
      attention: [],
      warnings: [],
      telegramConnections: 0,
      intervalSec: 10,
      telegramProblem: null,
    });
    expect(dash).toContain("3 per side");
    expect(renderStartedMessage(state.pair, state.config)).toContain(
      "3 levels/side",
    );
  });
});

describe("the Telegram line of the dashboard", () => {
  function telegramLine(telegramProblem: string | null, tickCount = 50) {
    const dash = stripVTControlCharacters(
      renderDashboard({
        state: makeState(),
        currentPrice: PRICE,
        uptime: 60 * 60 * 1000,
        tickCount,
        lastError: null,
        attention: [],
        warnings: [],
        telegramConnections: 1,
        intervalSec: 10,
        telegramProblem,
      }),
    );
    return dash.split("\n").find((line) => line.includes("Telegram"))!;
  }

  it("raises no warning after a quiet spell", () => {
    expect(telegramLine(null)).not.toContain("\u26A0");
  });

  it("warns with the reason when the latest send failed", () => {
    expect(telegramLine("HTTP 401: Unauthorized")).toContain(
      "1 connection  \u26A0 last send failed: HTTP 401: Unauthorized",
    );
  });
});

describe("renderRiskLine", () => {
  it("returns null when neither trailing-up nor stop-loss is configured", () => {
    expect(renderRiskLine(makeState(), PRICE)).toBeNull();
  });

  it("renders the trailing-up trigger with distance from current price", () => {
    expect(renderRiskLine(makeState({ trailingUp: true }), PRICE)).toBe(
      "Trail up $109,288.78 (+9.3%)",
    );
  });

  it("renders the stop-loss with distance from current price", () => {
    expect(renderRiskLine(makeState({ stopLoss: "82000" }), PRICE)).toBe(
      "Stop $82,000.00 (-18.0%)",
    );
  });

  it("renders both when configured together", () => {
    expect(
      renderRiskLine(makeState({ trailingUp: true, stopLoss: "82000" }), PRICE),
    ).toBe("Trail up $109,288.78 (+9.3%) \u00B7 Stop $82,000.00 (-18.0%)");
  });

  it("groups the shift count with the trailing-up segment", () => {
    const state = makeState({ trailingUp: true, stopLoss: "82000" });
    state.shiftCount = 2;
    expect(renderRiskLine(state, PRICE)).toBe(
      "Trail up $109,288.78 (+9.3%) \u00B7 Shifts 2 \u00B7 Stop $82,000.00 (-18.0%)",
    );
  });

  it("omits the shift count when trailing-up is disabled", () => {
    const state = makeState({ stopLoss: "82000" });
    state.shiftCount = 2;
    expect(renderRiskLine(state, PRICE)).toBe("Stop $82,000.00 (-18.0%)");
  });

  it("omits the distance when no current price is known", () => {
    expect(
      renderRiskLine(makeState({ stopLoss: "82000" }), new Decimal(0)),
    ).toBe("Stop $82,000.00");
  });

  it("emits no chalk escape codes for the Telegram card", () => {
    const line = renderRiskLine(
      makeState({ trailingUp: true, stopLoss: "82000" }),
      PRICE,
    )!;
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/\x1B\[/);
  });
});

describe("renderReconciliationSummary", () => {
  const NO_ORDERS = {
    buysFilled: 0,
    sellsFilled: 0,
    kept: 0,
    gone: 0,
    replaced: 0,
    resent: 0,
    renewed: {},
    unlisted: 0,
    held: 0,
  };

  it("says a pending order closed on the exchange was placed anew", () => {
    // when
    const output = stripVTControlCharacters(
      renderReconciliationSummary({
        ...NO_ORDERS,
        renewed: { cancelled: 1, rejected: 2, replaced: 1 },
      }),
    );

    // then
    expect(output).toContain(
      "1 pending order was cancelled on the exchange, a new one was placed",
    );
    expect(output).toContain(
      "2 pending orders were rejected by the exchange, new ones were placed",
    );
    expect(output).toContain(
      "1 pending order was replaced outside the bot, a new one was placed. The replacement isn't tracked: revx order open",
    );
    expect(output).not.toContain("sent again");
    expect(output).not.toContain("No leftover orders");
  });

  it("says a saved order replaced outside the bot apart from orders gone", () => {
    // when
    const output = stripVTControlCharacters(
      renderReconciliationSummary({ ...NO_ORDERS, gone: 1, replaced: 2 }),
    );

    // then
    expect(output).toContain(
      "2 orders were replaced outside the bot. The replacements aren't tracked: revx order open",
    );
    expect(output).toContain("1 order expired/cancelled on exchange");
  });

  it("says no leftover orders only when nothing was found", () => {
    expect(
      stripVTControlCharacters(renderReconciliationSummary(NO_ORDERS)),
    ).toContain("No leftover orders from previous session");
  });

  it("lists orders sent again apart from orders kept", () => {
    // when
    const output = stripVTControlCharacters(
      renderReconciliationSummary({ ...NO_ORDERS, kept: 1, resent: 2 }),
    );

    // then
    expect(output).toContain("1 order kept from previous session");
    expect(output).toContain("2 pending orders sent again");
  });

  it("uses the singular for one order sent again", () => {
    // when
    const output = stripVTControlCharacters(
      renderReconciliationSummary({ ...NO_ORDERS, resent: 1 }),
    );

    // then
    expect(output).toContain("1 pending order sent again");
    expect(output).not.toContain("kept from previous session");
    expect(output).not.toContain("No leftover orders");
  });

  it("lists orders the exchange doesn't list yet apart from orders gone", () => {
    // when
    const output = stripVTControlCharacters(
      renderReconciliationSummary({ ...NO_ORDERS, gone: 1, unlisted: 2 }),
    );

    // then
    expect(output).toContain(
      "2 orders not listed by the exchange yet, looked up again",
    );
    expect(output).toContain("1 order expired/cancelled on exchange");
  });

  it("uses the singular for one order not listed yet", () => {
    // when
    const output = stripVTControlCharacters(
      renderReconciliationSummary({ ...NO_ORDERS, unlisted: 1 }),
    );

    // then
    expect(output).toContain(
      "1 order not listed by the exchange yet, looked up again",
    );
    expect(output).not.toContain("No leftover orders");
  });

  it("says rejected orders are looked up by their client order IDs for up to 5 minutes", () => {
    // when
    const output = stripVTControlCharacters(
      renderReconciliationSummary({ ...NO_ORDERS, held: 2 }),
    );

    // then
    expect(output).toContain(
      "2 orders rejected or already placed, looked up by client order ID for up to 5 minutes",
    );
    expect(output).not.toContain("No leftover orders");
  });
});

describe("renderDashboard notices", () => {
  it("shows the check's warnings before lasting problems and counts both when cut", () => {
    // given
    const data = {
      state: makeState(),
      currentPrice: new Decimal("100"),
      uptime: 1000,
      tickCount: 1,
      lastError: null,
      attention: ["Buy @99 not placed: one", "Buy @98 not placed: two"],
      warnings: [
        "Sell @101 rejected, retrying (2/3)",
        "Price below grid range",
      ],
      telegramConnections: 0,
      intervalSec: 10,
      telegramProblem: null,
    };

    // when
    const output = stripVTControlCharacters(renderDashboard(data));

    // then
    const shown = [
      "Sell @101 rejected, retrying (2/3)",
      "Price below grid range",
      "Buy @99 not placed: one",
    ].map((notice) => output.indexOf(notice));
    expect(shown.every((index) => index >= 0)).toBe(true);
    expect([...shown].sort((a, b) => a - b)).toEqual(shown);
    expect(output).not.toContain("Buy @98 not placed: two");
    expect(output).toContain("...and 1 more");
  });
});

describe("renderDashboard open buy fills", () => {
  const data = {
    state: makeState(),
    currentPrice: new Decimal("100"),
    uptime: 1000,
    tickCount: 1,
    lastError: null,
    attention: [],
    warnings: [],
    telegramConnections: 0,
    intervalSec: 10,
    telegramProblem: null,
  };

  it("shows what open buys have already bought under the coins held", () => {
    // when
    const output = stripVTControlCharacters(
      renderDashboard({ ...data, openBuyFills: new Decimal("0.04") }),
    );

    // then
    expect(output).toMatch(/BTC Held\s+0\.00000000/);
    expect(output).toMatch(/Open buy fills\s+0\.04000000/);
  });

  it("leaves the row out while open buys have bought nothing", () => {
    // when
    const output = stripVTControlCharacters(
      renderDashboard({ ...data, openBuyFills: new Decimal("0") }),
    );

    // then
    expect(output).not.toContain("Open buy fills");
  });
});

describe("renderDashboard frame", () => {
  function dashboardLines(state = makeState()): string[] {
    return stripVTControlCharacters(
      renderDashboard({
        state,
        currentPrice: new Decimal("100"),
        uptime: 1000,
        tickCount: 1,
        lastError: null,
        attention: [],
        warnings: [],
        telegramConnections: 0,
        intervalSec: 10,
        telegramProblem: null,
      }),
    ).split("\n");
  }

  it("draws every divider as wide as the box, with no gap when untitled", () => {
    // when
    const lines = dashboardLines();

    // then
    const width = [...lines[0]].length;
    const dividers = lines.filter((line) => line.startsWith("\u2560"));
    expect(dividers.length).toBeGreaterThan(1);
    for (const divider of dividers) {
      expect([...divider].length).toBe(width);
    }
    expect(dividers).toContainEqual(
      `\u2560${"\u2550".repeat(width - 2)}\u2563`,
    );
  });

  it("shows a whole outside-change line in an 80-column terminal", () => {
    // given
    const columns = process.stdout.columns;
    process.stdout.columns = 80;
    const notices = [
      "2 orders cancelled outside the bot, placed again (last 17:18:53)",
      "2 orders replaced outside the bot, placed again, replacements untracked",
    ];

    // when
    const output = stripVTControlCharacters(
      renderDashboard({
        state: makeState(),
        currentPrice: new Decimal("100"),
        uptime: 1000,
        tickCount: 1,
        lastError: null,
        attention: notices,
        warnings: [],
        telegramConnections: 0,
        intervalSec: 10,
        telegramProblem: null,
      }),
    );
    process.stdout.columns = columns;

    // then
    for (const notice of notices) expect(output).toContain(notice);
  });

  it("shows the grid range from the lowest and highest levels", () => {
    // given
    const state = makeState();
    state.levels = makeLevels(["93", "97", "101", "105", "108", "112"]);

    // when
    const range = dashboardLines(state).find((line) =>
      line.includes("Grid Range"),
    );

    // then
    expect(range).toContain("$93.00 \u2014 $112.00");
  });
});

describe("renderDashboard trailing-up row", () => {
  function dashboard(state: GridState): string {
    return renderDashboard({
      state,
      currentPrice: PRICE,
      uptime: 1000,
      tickCount: 1,
      lastError: null,
      attention: [],
      warnings: [],
      telegramConnections: 0,
      intervalSec: 10,
      telegramProblem: null,
    });
  }

  it("shows the trigger price when trailing-up is enabled", () => {
    const out = dashboard(makeState({ trailingUp: true }));
    expect(out).toContain("Trail Up");
    expect(out).toContain("$109,288.78");
  });

  it("omits the row when trailing-up is disabled", () => {
    expect(dashboard(makeState())).not.toContain("Trail Up");
  });
});

describe("renderDashboard large grids", () => {
  it("shows a bounded window around the current price", () => {
    // given
    const state = makeState();
    state.config.levels = 200;
    state.levels = Array.from({ length: 200 }, (_, index) => ({
      index,
      price: String(50_000 + index * 100),
      buyOrderIds: index < 100 ? [`buy-${index}`] : [],
      positions: [],
    }));

    // when
    const output = renderDashboard({
      state,
      currentPrice: new Decimal("60000"),
      uptime: 1000,
      tickCount: 1,
      lastError: null,
      attention: [],
      warnings: [],
      telegramConnections: 0,
      intervalSec: 10,
      telegramProblem: null,
    });
    const plainOutput = stripVTControlCharacters(output);
    const renderedLevelRows = plainOutput
      .split("\n")
      .filter((line) => /║\s+#\s*\d+/.test(line));

    // then
    expect(renderedLevelRows).toHaveLength(24);
    expect(plainOutput).toContain("#101");
    expect(plainOutput).toMatch(/\d+ higher levels hidden/);
    expect(plainOutput).toMatch(/\d+ lower levels hidden/);
  });

  it("aligns order bars across two-digit and three-digit level numbers", () => {
    // given
    const state = makeState();
    state.config.levels = 200;
    state.levels = Array.from({ length: 200 }, (_, index) => ({
      index,
      price: String(50_000 + index * 100),
      buyOrderIds: index < 100 ? [`buy-${index}`] : [],
      positions: [],
    }));

    // when
    const plainOutput = stripVTControlCharacters(
      renderDashboard({
        state,
        currentPrice: new Decimal("60000"),
        uptime: 1000,
        tickCount: 1,
        lastError: null,
        attention: [],
        warnings: [],
        telegramConnections: 0,
        intervalSec: 10,
        telegramProblem: null,
      }),
    );
    const levelRows = plainOutput.split("\n");
    const level100 = levelRows.find((line) => line.includes("#100"))!;
    const level99 = levelRows.find((line) => /#\s*99\s/.test(line))!;

    // then
    expect(level100).toContain("$");
    expect(level99).toContain("$");
    expect(level100).toContain("▒▒▒▒▒");
    expect(level99).toContain("▒▒▒▒▒");
    expect(level100).toContain("BUY");
    expect(level99).toContain("BUY");
    expect(level100.indexOf("$")).toBe(level99.indexOf("$"));
    expect(level100.indexOf("▒▒▒▒▒")).toBe(level99.indexOf("▒▒▒▒▒"));
    expect(level100.indexOf("BUY")).toBe(level99.indexOf("BUY"));
  });
});

describe("renderShutdownSummary", () => {
  it("prints the notes about what the stop left behind", () => {
    // given
    const note =
      "\u26A0 1 order was replaced outside the bot. The replacement isn't tracked and wasn't cancelled. Check revx order open.";

    // when
    const output = stripVTControlCharacters(
      renderShutdownSummary(makeState(), new Decimal("100"), [note]),
    );

    // then
    expect(output).toContain(note);
    expect(output).not.toContain("Clean exit.");
  });

  it("says the exit is clean when nothing was left behind", () => {
    expect(
      stripVTControlCharacters(
        renderShutdownSummary(makeState(), new Decimal("100")),
      ),
    ).toContain("All orders cancelled. Clean exit.");
  });
});
