import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Ticker, Candle } from "revolutx-api";

const mockGetTickers = vi.fn();
const mockGetCandles = vi.fn();

vi.mock("../src/util/client.js", () => ({
  getClient: () => ({
    getTickers: mockGetTickers,
    getCandles: mockGetCandles,
  }),
}));

import { createProgram } from "../src/index.js";

function runCommand(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => {
        output += a.join(" ") + "\n";
      });
    const program = createProgram();
    program.exitOverride();
    program.parseAsync(["node", "revx", ...args]).then(() => {
      spy.mockRestore();
      resolve(output);
    });
  });
}

const MOCK_TICKERS: { data: Ticker[]; metadata: { timestamp: number } } = {
  data: [
    { symbol: "BTC-USD", bid: "90000", ask: "90010", mid: "90005", last_price: "90005" },
    { symbol: "ETH-USD", bid: "3000", ask: "3001", mid: "3000.5", last_price: "3000.5" },
  ],
  metadata: { timestamp: 1700000000000 },
};

const MOCK_CANDLES: { data: Candle[] } = {
  data: [
    { start: 1700000000000, open: "90000", high: "91000", low: "89000", close: "90500", volume: "100" },
  ],
};

describe("market tickers", () => {
  beforeEach(() => {
    mockGetTickers.mockResolvedValue(MOCK_TICKERS);
  });

  it("calls getTickers without options when no --symbols", async () => {
    await runCommand(["market", "tickers", "--json"]);
    expect(mockGetTickers).toHaveBeenCalledWith(undefined);
  });

  it("passes symbols array when --symbols is given", async () => {
    await runCommand(["market", "tickers", "--symbols", "BTC-USD,ETH-USD", "--json"]);
    expect(mockGetTickers).toHaveBeenCalledWith({ symbols: ["BTC-USD", "ETH-USD"] });
  });
});

describe("market candles", () => {
  beforeEach(() => {
    mockGetCandles.mockResolvedValue(MOCK_CANDLES);
  });

  it("uses startDate/endDate fields (not since/until)", async () => {
    await runCommand([
      "market", "candles", "BTC-USD",
      "--since", "2025-01-01",
      "--until", "2025-01-02",
      "--json",
    ]);
    const callArgs = mockGetCandles.mock.calls[0];
    expect(callArgs[0]).toBe("BTC-USD");
    expect(callArgs[1]).toHaveProperty("startDate");
    expect(callArgs[1]).toHaveProperty("endDate");
    expect(callArgs[1]).not.toHaveProperty("since");
    expect(callArgs[1]).not.toHaveProperty("until");
  });

  it("resolves interval string alias 1h to 60 minutes", async () => {
    await runCommand(["market", "candles", "BTC-USD", "--interval", "1h", "--json"]);
    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", expect.objectContaining({ interval: 60 }));
  });

  it("resolves interval string alias 4h to 240 minutes", async () => {
    await runCommand(["market", "candles", "BTC-USD", "--interval", "4h", "--json"]);
    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", expect.objectContaining({ interval: 240 }));
  });

  it("resolves interval string alias 1d to 1440 minutes", async () => {
    await runCommand(["market", "candles", "BTC-USD", "--interval", "1d", "--json"]);
    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", expect.objectContaining({ interval: 1440 }));
  });

  it("accepts numeric minutes as interval", async () => {
    await runCommand(["market", "candles", "BTC-USD", "--interval", "30", "--json"]);
    expect(mockGetCandles).toHaveBeenCalledWith("BTC-USD", expect.objectContaining({ interval: 30 }));
  });
});
