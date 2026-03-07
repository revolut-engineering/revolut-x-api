import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountBalance } from "revolutx-api";

const mockGetBalances = vi.fn<() => Promise<AccountBalance[]>>();

vi.mock("../src/util/client.js", () => ({
  getClient: () => ({ getBalances: mockGetBalances }),
}));

const BALANCES: AccountBalance[] = [
  { currency: "BTC", available: "1.5", reserved: "0", total: "1.5" },
  { currency: "ETH", available: "0", reserved: "0", total: "0" },
  { currency: "USD", available: "500", reserved: "100", total: "600" },
  { currency: "SOL", available: "0", reserved: "0", total: "0" },
];

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

describe("account balances", () => {
  beforeEach(() => {
    mockGetBalances.mockResolvedValue(BALANCES);
  });

  it("filters out zero balances by default", async () => {
    const output = await runCommand(["account", "balances", "--json"]);
    const data = JSON.parse(output);
    expect(data).toHaveLength(2);
    expect(data.map((b: AccountBalance) => b.currency)).toEqual(["BTC", "USD"]);
  });

  it("includes zero balances with --all flag", async () => {
    const output = await runCommand(["account", "balances", "--all", "--json"]);
    const data = JSON.parse(output);
    expect(data).toHaveLength(4);
  });

  it("includes zero balances with -a flag", async () => {
    const output = await runCommand(["account", "balances", "-a", "--json"]);
    const data = JSON.parse(output);
    expect(data).toHaveLength(4);
  });

  it("single-currency balance command is unaffected by filtering", async () => {
    const output = await runCommand(["account", "balance", "ETH", "--json"]);
    const data = JSON.parse(output);
    expect(data.currency).toBe("ETH");
    expect(data.total).toBe("0");
  });
});
