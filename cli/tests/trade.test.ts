import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PublicTrade } from "revolutx-api";

const mockGetAllTrades = vi.fn();
const mockGetPrivateTrades = vi.fn();

vi.mock("../src/util/client.js", () => ({
  getClient: () => ({
    getAllTrades: mockGetAllTrades,
    getPrivateTrades: mockGetPrivateTrades,
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

const MOCK_PUBLIC_TRADES: { data: PublicTrade[] } = {
  data: [
    { id: "t-1", symbol: "BTC-USD", price: "90000", quantity: "0.001", timestamp: 1700000000000 },
  ],
};

describe("trade all", () => {
  beforeEach(() => {
    mockGetAllTrades.mockClear();
    mockGetAllTrades.mockResolvedValue(MOCK_PUBLIC_TRADES);
  });

  it("calls getAllTrades with symbol", async () => {
    await runCommand(["trade", "all", "BTC-USD", "--json"]);
    expect(mockGetAllTrades).toHaveBeenCalledWith("BTC-USD", expect.any(Object));
  });

  it("passes limit option", async () => {
    await runCommand(["trade", "all", "BTC-USD", "--limit", "50", "--json"]);
    expect(mockGetAllTrades).toHaveBeenCalledWith(
      "BTC-USD",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("passes startDate and endDate when provided", async () => {
    await runCommand([
      "trade", "all", "BTC-USD",
      "--start-date", "2025-01-01",
      "--end-date", "2025-01-02",
      "--json",
    ]);
    const callArgs = mockGetAllTrades.mock.calls[0];
    expect(callArgs[0]).toBe("BTC-USD");
    expect(callArgs[1]).toHaveProperty("startDate");
    expect(callArgs[1]).toHaveProperty("endDate");
  });

  it("outputs JSON with trade fields", async () => {
    const output = await runCommand(["trade", "all", "BTC-USD", "--json"]);
    const data = JSON.parse(output);
    expect(data).toEqual(MOCK_PUBLIC_TRADES);
  });
});
