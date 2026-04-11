import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
} from "../src/output/formatter.js";

describe("isJsonOutput", () => {
  it("returns true for --json flag", () => {
    expect(isJsonOutput({ json: true })).toBe(true);
  });

  it("returns true for --output json", () => {
    expect(isJsonOutput({ output: "json" })).toBe(true);
  });

  it("returns false for table output", () => {
    expect(isJsonOutput({ output: "table" })).toBe(false);
  });

  it("returns false when no flags", () => {
    expect(isJsonOutput({})).toBe(false);
  });
});

describe("printJson", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs formatted JSON", () => {
    printJson({ key: "value" });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ key: "value" }, null, 2),
    );
  });
});

describe("printTable", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs table for non-empty data", () => {
    printTable(
      [{ name: "BTC", price: "95000" }],
      [
        { header: "Name", key: "name" },
        { header: "Price", key: "price" },
      ],
    );
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("BTC");
    expect(output).toContain("95000");
  });

  it("outputs 'No data found.' for empty array", () => {
    printTable([], [{ header: "Name", key: "name" }]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("No data found");
  });
});

describe("printKeyValue", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs key-value pairs", () => {
    printKeyValue([
      ["Symbol", "BTC"],
      ["Price", "95000"],
    ]);
    expect(logSpy).toHaveBeenCalledTimes(2);
  });
});
