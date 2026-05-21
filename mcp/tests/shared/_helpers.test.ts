import { describe, it, expect } from "vitest";
import { parseDateRange, formatDate } from "../../src/shared/_helpers.js";

describe("parseDateRange local-time input", () => {
  it("parses a bare YYYY-MM-DD as local midnight", () => {
    const result = parseDateRange("2024-01-15", "2024-01-15", {
      endDefaultsToNow: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.parsedStartDate).toBe(new Date(2024, 0, 15).getTime());
  });

  it("keeps explicit-offset ISO input as the absolute instant", () => {
    const result = parseDateRange(
      "2024-01-15T00:00:00Z",
      "2024-01-16T00:00:00Z",
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.parsedStartDate).toBe(Date.parse("2024-01-15T00:00:00Z"));
  });
});

describe("formatDate local-time output", () => {
  it("renders local wall-clock time with a (local) suffix", () => {
    const ms = 1700000000000;
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (local)`;
    expect(formatDate(ms)).toBe(expected);
  });
});
