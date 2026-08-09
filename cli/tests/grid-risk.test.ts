import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  levelsPerSide,
  trailUpTriggerFromBounds,
  trailUpTriggerPrice,
} from "../src/engine/grid-math.js";
import {
  renderDashboard,
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
    expect(trigger!.toFixed(2)).toBe("108205.85");
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
      warnings: [],
      telegramConnections: 0,
      intervalSec: 10,
      lastNotifyOk: 0,
    });
    expect(dash).toContain("3 per side");
    expect(renderStartedMessage(state.pair, state.config)).toContain(
      "3 levels/side",
    );
  });
});

describe("renderRiskLine", () => {
  it("returns null when neither trailing-up nor stop-loss is configured", () => {
    expect(renderRiskLine(makeState(), PRICE)).toBeNull();
  });

  it("renders the trailing-up trigger with distance from current price", () => {
    expect(renderRiskLine(makeState({ trailingUp: true }), PRICE)).toBe(
      "Trail up $108,205.85 (+8.2%)",
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
    ).toBe("Trail up $108,205.85 (+8.2%) \u00B7 Stop $82,000.00 (-18.0%)");
  });

  it("groups the shift count with the trailing-up segment", () => {
    const state = makeState({ trailingUp: true, stopLoss: "82000" });
    state.shiftCount = 2;
    expect(renderRiskLine(state, PRICE)).toBe(
      "Trail up $108,205.85 (+8.2%) \u00B7 Shifts 2 \u00B7 Stop $82,000.00 (-18.0%)",
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

describe("renderDashboard trailing-up row", () => {
  function dashboard(state: GridState): string {
    return renderDashboard({
      state,
      currentPrice: PRICE,
      uptime: 1000,
      tickCount: 1,
      lastError: null,
      warnings: [],
      telegramConnections: 0,
      intervalSec: 10,
      lastNotifyOk: 0,
    });
  }

  it("shows the trigger price when trailing-up is enabled", () => {
    const out = dashboard(makeState({ trailingUp: true }));
    expect(out).toContain("Trail Up");
    expect(out).toContain("$108,205.85");
  });

  it("omits the row when trailing-up is disabled", () => {
    expect(dashboard(makeState())).not.toContain("Trail Up");
  });
});
