import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  renderOrderLadder,
  fmtSignedPnl,
  fmtMoney,
} from "../src/engine/grid-renderer.js";
import type { GridState } from "../src/db/grid-store.js";

function makeState(pair: string): GridState {
  return {
    id: "x",
    pair,
    version: 1,
    createdAt: "",
    updatedAt: "",
    config: {
      levels: 6,
      rangePct: "0.2",
      investment: "500",
      splitInvestment: true,
      intervalSec: 10,
      dryRun: true,
    },
    splitExecuted: true,
    gridPrice: "62500",
    quotePrecision: "0.01",
    basePrecision: "0.00001",
    quotePerLevel: "83.33",
    levels: [
      {
        index: 0,
        price: "50299.13",
        buyOrderIds: ["b0a", "b0b"],
        positions: [],
      },
      { index: 1, price: "54547.98", buyOrderIds: ["b1"], positions: [] },
      {
        index: 2,
        price: "59155.75",
        buyOrderIds: ["b2"],
        positions: [
          { id: "p2", baseHeld: "0.00133", fillCost: "78", sellOrderId: "s2" },
        ],
      },
      {
        index: 3,
        price: "64152.74",
        buyOrderIds: [],
        positions: [
          { id: "p3", baseHeld: "0.00133", fillCost: "78", sellOrderId: "s3" },
        ],
      },
      {
        index: 4,
        price: "69571.84",
        buyOrderIds: [],
        positions: [
          { id: "p4", baseHeld: "0.00133", fillCost: "78", sellOrderId: "s4" },
        ],
      },
      { index: 5, price: "75448.69", buyOrderIds: [], positions: [] },
    ],
    stats: { totalBuys: 0, totalSells: 0, realizedPnl: "0", totalFees: "0" },
    tradeLog: [],
  };
}

const price = new Decimal("62913.86");

describe("renderOrderLadder", () => {
  it("summarizes buy/sell counts in the header", () => {
    const lines = renderOrderLadder(makeState("BTC-USD"), price);
    expect(lines[0]).toBe("Open orders: 4 buys · 3 sells");
  });

  it("places the sell one level above its position with base qty (5dp)", () => {
    const lines = renderOrderLadder(makeState("BTC-USD"), price);
    const sell = lines.find((l) => l.includes("SELL") && l.includes("#4"))!;
    expect(sell).toContain("$64,152.74");
    expect(sell).toContain("0.00133");
  });

  it("groups multiple buys on one level with a count and no size", () => {
    const lines = renderOrderLadder(makeState("BTC-USD"), price);
    const buy = lines.find((l) => l.includes("#1"))!;
    expect(buy).toContain("BUY (2)");
    expect(buy).toContain("$50,299.13");
    expect(buy).not.toMatch(/\$83\.33/);
  });

  it("inserts the current-price marker between sells and buys", () => {
    const lines = renderOrderLadder(makeState("BTC-USD"), price);
    const markerIdx = lines.findIndex((l) => l.includes("◄"));
    expect(markerIdx).toBeGreaterThan(0);
    expect(lines[markerIdx]).toContain("$62,913.86");
    lines.forEach((l, i) => {
      if (l.includes("SELL")) expect(i).toBeLessThan(markerIdx);
      if (l.includes("BUY")) expect(i).toBeGreaterThan(markerIdx);
    });
  });

  it("does not render unsold (held) base", () => {
    const state = makeState("BTC-USD");
    for (const lv of state.levels) {
      lv.buyOrderIds = [];
      lv.positions = [];
    }
    state.levels[1].positions = [
      { id: "h1", baseHeld: "0.003", fillCost: "180", sellOrderId: null },
      { id: "h2", baseHeld: "0.002", fillCost: "120", sellOrderId: null },
    ];
    const lines = renderOrderLadder(state, price);
    expect(lines).toEqual([]);
    expect(lines.join("\n")).not.toContain("Holdings");
  });

  it("renders EUR and GBP symbols, never hardcoding USD", () => {
    const eur = renderOrderLadder(makeState("BTC-EUR"), price).join("\n");
    expect(eur).toContain("€64,152.74");
    expect(eur).not.toContain("$");

    const gbp = renderOrderLadder(makeState("BTC-GBP"), price).join("\n");
    expect(gbp).toContain("£50,299.13");
    expect(gbp).not.toContain("$");
  });

  it("handles an empty grid", () => {
    const state = makeState("BTC-USD");
    for (const lv of state.levels) {
      lv.buyOrderIds = [];
      lv.positions = [];
    }
    const lines = renderOrderLadder(state, price);
    expect(lines).toEqual([]);
  });

  it("caps the ladder to maxRows, keeping the rows nearest the price", () => {
    const state = makeState("BTC-USD");
    state.levels = [];
    for (let i = 0; i < 20; i++) {
      state.levels.push({
        index: i,
        price: String((i + 1) * 100),
        buyOrderIds: [`b${i}`],
        positions: [],
      });
    }
    const lines = renderOrderLadder(state, new Decimal("1050"), { maxRows: 6 });
    const rowLines = lines.filter((l) => /^ #\d/.test(l));
    expect(rowLines.length).toBe(6);
    expect(lines.filter((l) => l.includes("… +")).length).toBe(2);
    expect(lines.some((l) => l.includes("◄"))).toBe(true);
    expect(rowLines.some((l) => l.includes("$1,100.00"))).toBe(true);
    expect(rowLines.some((l) => l.includes("$1,000.00"))).toBe(true);
    expect(rowLines.some((l) => l.includes("$2,000.00"))).toBe(false);
    expect(rowLines.some((l) => l.includes("$100.00"))).toBe(false);
  });

  it("keeps the highest rows when the price is above the whole grid", () => {
    const state = makeState("BTC-USD");
    state.levels = [];
    for (let i = 0; i < 20; i++) {
      state.levels.push({
        index: i,
        price: String((i + 1) * 100),
        buyOrderIds: [`b${i}`],
        positions: [],
      });
    }
    const lines = renderOrderLadder(state, new Decimal("9999"), { maxRows: 6 });
    const rowLines = lines.filter((l) => /^ #\d/.test(l));
    expect(rowLines.length).toBe(6);
    expect(rowLines.some((l) => l.includes("$2,000.00"))).toBe(true);
    expect(rowLines.some((l) => l.includes("$1,900.00"))).toBe(true);
    expect(rowLines.some((l) => l.includes("$100.00"))).toBe(false);
    expect(lines[lines.length - 1]).toContain("… +");
  });

  it("keeps the lowest rows when the price is below the whole grid", () => {
    const state = makeState("BTC-USD");
    state.levels = [];
    for (let i = 0; i < 20; i++) {
      state.levels.push({
        index: i,
        price: String((i + 1) * 100),
        buyOrderIds: [`b${i}`],
        positions: [],
      });
    }
    const lines = renderOrderLadder(state, new Decimal("1"), { maxRows: 6 });
    const rowLines = lines.filter((l) => /^ #\d/.test(l));
    expect(rowLines.length).toBe(6);
    expect(rowLines.some((l) => l.includes("$100.00"))).toBe(true);
    expect(rowLines.some((l) => l.includes("$200.00"))).toBe(true);
    expect(rowLines.some((l) => l.includes("$2,000.00"))).toBe(false);
    expect(lines[1]).toContain("… +");
  });
});

describe("fmtSignedPnl", () => {
  it("puts the minus before the currency symbol for negatives", () => {
    expect(fmtSignedPnl(new Decimal("-1.18"), "$")).toBe("-$1.18");
  });

  it("omits the sign when the value rounds to zero", () => {
    expect(fmtSignedPnl(new Decimal("0"), "$")).toBe("$0.00");
    expect(fmtSignedPnl(new Decimal("-0.001"), "$")).toBe("$0.00");
    expect(fmtSignedPnl(new Decimal("0.004"), "$")).toBe("$0.00");
  });

  it("prefixes a plus for positives", () => {
    expect(fmtSignedPnl(new Decimal("12.5"), "€")).toBe("+€12.50");
  });
});

describe("fmtMoney", () => {
  it("renders negatives as -€X and positives plainly", () => {
    expect(fmtMoney(new Decimal("498.82"), "$")).toBe("$498.82");
    expect(fmtMoney(new Decimal("-5"), "£")).toBe("-£5.00");
  });
});
