import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revx-grid-store-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getConfigDir: () => tempDir,
    ensureConfigDir: () => {},
  };
});

const {
  loadGridState,
  saveGridState,
  setAsideGridState,
  GridStateDamagedError,
  GridStateUnreadableError,
} = await import("../src/db/grid-store.js");

const FILE = "grid_state_BTC-USD.json";

describe("grid save file", () => {
  it("reports no saved grid when the file doesn't exist", () => {
    // when
    const state = loadGridState("BTC-USD");

    // then
    expect(state).toBeNull();
  });

  it("refuses a file that isn't valid JSON", () => {
    // given
    writeFileSync(join(tempDir, FILE), "{ broken");

    // when
    const load = () => loadGridState("BTC-USD");

    // then
    expect(load).toThrow(GridStateDamagedError);
    expect(load).toThrow(/grid_state_BTC-USD\.json is damaged/);
  });

  it("refuses valid JSON that isn't a grid save file", () => {
    // given
    writeFileSync(join(tempDir, FILE), JSON.stringify({ hello: "world" }));

    // when
    const load = () => loadGridState("BTC-USD");

    // then
    expect(load).toThrow(GridStateDamagedError);
  });

  it("refuses an empty file", () => {
    // given
    writeFileSync(join(tempDir, FILE), "");

    // when
    const load = () => loadGridState("BTC-USD");

    // then
    expect(load).toThrow(GridStateDamagedError);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a file it isn't allowed to read as a read error, not as damaged",
    () => {
      // given
      const path = join(tempDir, FILE);
      writeFileSync(path, "{}");
      chmodSync(path, 0o000);

      // when
      const load = () => loadGridState("BTC-USD");

      // then
      expect(load).toThrow(GridStateUnreadableError);
      expect(load).toThrow(
        `The saved grid file ${path} can't be read (EACCES). Nothing was started. Make sure the file and its folder belong to you and you can read them, for example: chmod 700 ${tempDir} and chmod 600 ${path}. Then run again.`,
      );
      expect(load).not.toThrow(GridStateDamagedError);
    },
  );

  it.skipIf(process.platform === "win32")(
    "gives no permission advice for a save file behind a broken link",
    () => {
      // given
      const path = join(tempDir, FILE);
      symlinkSync(path, path);

      // when
      const load = () => loadGridState("BTC-USD");

      // then
      expect(load).toThrow(
        `The saved grid file ${path} can't be read (ELOOP). Nothing was started. Check ${path} and fix what stops it from being read, such as a broken link. Then run again.`,
      );
    },
  );

  it("says a folder in place of the save file is a folder", () => {
    // given
    const path = join(tempDir, FILE);
    mkdirSync(path);

    // when
    const load = () => loadGridState("BTC-USD");

    // then
    expect(load).toThrow(GridStateUnreadableError);
    expect(load).toThrow(
      `The saved grid file ${path} is a folder, not a file. Nothing was started. Move it aside, then run again.`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "saves the grid readable only by its owner, even over a looser file, and leaves nothing behind",
    () => {
      // given
      const path = join(tempDir, FILE);
      writeFileSync(path, "{}", { mode: 0o644 });
      chmodSync(path, 0o644);

      // when
      saveGridState({
        id: "grid",
        pair: "BTC-USD",
        levels: [],
        tradeLog: [],
      } as unknown as Parameters<typeof saveGridState>[0]);

      // then
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(tempDir)).toEqual([FILE]);
    },
  );

  it("sets a damaged file aside instead of deleting it", () => {
    // given
    writeFileSync(join(tempDir, FILE), "{ broken");

    // when
    const keptAt = setAsideGridState("BTC-USD");

    // then
    expect(existsSync(join(tempDir, FILE))).toBe(false);
    expect(existsSync(keptAt)).toBe(true);
    expect(readdirSync(tempDir)).toEqual([
      expect.stringMatching(/^grid_state_BTC-USD\.json\.damaged-\d+$/),
    ]);
  });
});

describe("slot amounts in older save files", () => {
  function save(level: Record<string, unknown>): void {
    writeFileSync(
      join(tempDir, FILE),
      JSON.stringify({
        id: "grid",
        pair: "BTC-USD",
        quotePerLevel: "10",
        levels: [
          { index: 0, price: "99", buyOrderIds: [], positions: [] },
          { index: 1, price: "100", buyOrderIds: [], positions: [], ...level },
        ],
        stats: { totalBuys: 0, totalSells: 0, realizedPnl: "0" },
      }),
    );
  }

  function position(id: string, fillCost: string, slotQuote?: string) {
    return {
      id,
      baseHeld: "0.06",
      fillCost,
      sellOrderId: null,
      ...(slotQuote ? { slotQuote } : {}),
    };
  }

  it("takes a leftover buy's amount out of the position it completes", () => {
    // given
    save({
      buyOrderIds: ["leftover"],
      buyOrderQuoteSizes: { leftover: "4" },
      positions: [position("partial", "6")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions[0].slotQuote).toBe("6");
  });

  it("does the same for a leftover buy that was never confirmed", () => {
    // given
    save({
      pendingBuyClientOrderIds: ["lost"],
      pendingBuyQuoteSizes: { lost: "4" },
      positions: [position("partial", "6")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions[0].slotQuote).toBe("6");
  });

  it("gives a position with no leftover the full per-level amount", () => {
    // given
    save({ positions: [position("full", "10")] });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions[0].slotQuote).toBe("10");
  });

  it("doesn't treat a full-size buy on the same level as a leftover", () => {
    // given
    save({
      buyOrderIds: ["second-slot"],
      buyOrderQuoteSizes: { "second-slot": "10" },
      positions: [position("full", "10")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions[0].slotQuote).toBe("10");
  });

  it("matches each leftover to one position only", () => {
    // given
    save({
      buyOrderIds: ["leftover"],
      buyOrderQuoteSizes: { leftover: "4" },
      positions: [position("first", "6"), position("second", "6")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions.map((p) => p.slotQuote)).toEqual([
      "6",
      "10",
    ]);
  });

  it("splits one slot between two parts that both filled", () => {
    // given
    save({
      positions: [position("first-part", "6"), position("second-part", "4")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions.map((p) => p.slotQuote)).toEqual([
      "6",
      "4",
    ]);
  });

  it("traces a leftover of a leftover back to one slot", () => {
    // given
    save({
      buyOrderIds: ["second-leftover"],
      buyOrderQuoteSizes: { "second-leftover": "3" },
      positions: [position("partial", "6"), position("leftover-part", "1")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions.map((p) => p.slotQuote)).toEqual([
      "6",
      "1",
    ]);
  });

  it("gives each position the largest leftover that completes it", () => {
    // given
    save({
      buyOrderIds: ["small", "large"],
      buyOrderQuoteSizes: { small: "4", large: "8" },
      positions: [position("cheap", "2"), position("dear", "6")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions.map((p) => p.slotQuote)).toEqual([
      "2",
      "6",
    ]);
  });

  it("gives a position with no usable cost the full amount and loads the file", () => {
    // given
    save({
      buyOrderIds: ["leftover"],
      buyOrderQuoteSizes: { leftover: "4" },
      positions: [
        { id: "no-cost", baseHeld: "0.01", sellOrderId: null },
        position("zero-cost", "0"),
        position("partial", "6"),
      ],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions.map((p) => p.slotQuote)).toEqual([
      "10",
      "10",
      "6",
    ]);
  });

  it("keeps the same slots after saving and loading again", () => {
    // given
    save({
      buyOrderIds: ["leftover"],
      buyOrderQuoteSizes: { leftover: "4" },
      positions: [position("partial", "6")],
    });
    const first = loadGridState("BTC-USD")!;
    writeFileSync(join(tempDir, FILE), JSON.stringify(first));

    // when
    const second = loadGridState("BTC-USD")!;

    // then
    expect(second.levels[1].positions).toEqual(first.levels[1].positions);
  });

  it("gives a partial position with no leftover the full amount", () => {
    // given
    save({ positions: [position("partial", "6")] });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions[0].slotQuote).toBe("10");
  });

  it("gives the room left in a shared slot to its most expensive part", () => {
    // given
    save({
      positions: [position("smaller", "4"), position("larger", "5.5")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions.map((p) => p.slotQuote)).toEqual([
      "4",
      "6",
    ]);
  });

  it("gives a position that cost a little more than one slot the full amount", () => {
    // given
    save({ positions: [position("with-fee", "10.01")] });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions[0].slotQuote).toBe("10");
  });

  it("leaves a position from a newer save file as it is", () => {
    // given
    save({
      buyOrderIds: ["leftover"],
      buyOrderQuoteSizes: { leftover: "4" },
      positions: [position("current", "6", "7")],
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.levels[1].positions[0].slotQuote).toBe("7");
  });
});

describe("the stop-loss marker of older save files", () => {
  function save(extra: Record<string, unknown>): void {
    writeFileSync(
      join(tempDir, FILE),
      JSON.stringify({
        id: "grid",
        pair: "BTC-USD",
        quotePerLevel: "10",
        updatedAt: "2026-01-01T00:00:00.000Z",
        levels: [{ index: 0, price: "99", buyOrderIds: [], positions: [] }],
        stats: { totalBuys: 0, totalSells: 0, realizedPnl: "0" },
        ...extra,
      }),
    );
  }

  it("turns a pending stop-loss sale into a pending sell-off", () => {
    // given
    save({ stopLossClientOrderId: "stop-loss-sale" });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.halt).toEqual({
      reason: "stop-loss",
      clientOrderId: "stop-loss-sale",
    });
    expect("stopLossClientOrderId" in state).toBe(false);
  });

  it("drops an empty old marker without starting a sell-off", () => {
    // given
    save({ stopLossClientOrderId: "" });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.halt).toBeUndefined();
    expect("stopLossClientOrderId" in state).toBe(false);
  });

  it("keeps a sell-off that is already pending and drops the old marker", () => {
    // given
    save({
      stopLossClientOrderId: "stop-loss-sale",
      halt: { reason: "rejected-orders" },
    });

    // when
    const state = loadGridState("BTC-USD")!;

    // then
    expect(state.halt).toEqual({ reason: "rejected-orders" });
    expect("stopLossClientOrderId" in state).toBe(false);
  });
});
