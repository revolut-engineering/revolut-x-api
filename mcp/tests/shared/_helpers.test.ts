import { afterEach, describe, it, expect, vi } from "vitest";
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

describe("parseDateRange strict dates", () => {
  function errorText(result: ReturnType<typeof parseDateRange>): string {
    return "error" in result
      ? (result.error.content[0] as { text: string }).text
      : "";
  }

  it.each([
    "2026-13-45",
    "2026-02-30",
    "2026-02-30T10:00",
    "2026-10-12T25:00",
    "March 5 2026",
  ])("refuses %j instead of rolling it over", (value) => {
    expect(errorText(parseDateRange(value, undefined))).toContain(
      `Invalid date format: '${value}'.`,
    );
  });

  it("reads a local date-time and a zoned one", () => {
    const local = parseDateRange("2026-10-12T10:30", "2026-10-12T11:00");
    expect(local).toEqual({
      parsedStartDate: new Date(2026, 9, 12, 10, 30).getTime(),
      parsedEndDate: new Date(2026, 9, 12, 11, 0).getTime(),
    });
    const zoned = parseDateRange("2026-10-12T10:30:00Z", "2026-10-12T11:00Z");
    expect(zoned).toEqual({
      parsedStartDate: Date.UTC(2026, 9, 12, 10, 30),
      parsedEndDate: Date.UTC(2026, 9, 12, 11, 0),
    });
  });

  it("refuses a start after the end", () => {
    expect(errorText(parseDateRange("2026-01-02", "2026-01-01"))).toBe(
      "Error: start_date must be before end_date.",
    );
  });
});

describe("parseDateRange edge inputs", () => {
  const previousTz = process.env.TZ;

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  function errorText(result: ReturnType<typeof parseDateRange>): string {
    return "error" in result
      ? (result.error.content[0] as { text: string }).text
      : "";
  }

  it("keeps milliseconds from a fraction with up to 9 digits", () => {
    expect(
      parseDateRange("2026-10-12T10:30:00.123456Z", "2026-10-12T11:00Z"),
    ).toMatchObject({ parsedStartDate: Date.UTC(2026, 9, 12, 10, 30, 0, 123) });
  });

  it("reads relative dates in any case and with spaces around them", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    expect(
      parseDateRange(" 7D ", undefined, { endDefaultsToNow: true }),
    ).toEqual({ parsedStartDate: now - 7 * 86_400_000, parsedEndDate: now });
    expect(parseDateRange("2w", undefined, { endDefaultsToNow: true })).toEqual(
      { parsedStartDate: now - 14 * 86_400_000, parsedEndDate: now },
    );
    vi.useRealTimers();
  });

  it("ends a window in the future at now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    expect(
      parseDateRange("7d", "9999-12-31", { endDefaultsToNow: true }),
    ).toEqual({ parsedStartDate: now - 7 * 86_400_000, parsedEndDate: now });
    vi.useRealTimers();
  });

  it("refuses a window that is wholly in the future", () => {
    expect(
      errorText(
        parseDateRange("2998-01-01", "2999-01-01", { endDefaultsToNow: true }),
      ),
    ).toBe("Error: start_date is in the future.");
  });

  it("refuses a date before 1970", () => {
    expect(errorText(parseDateRange("99999999999d", undefined))).toContain(
      "That is before 1970.",
    );
  });

  it("refuses a local time that the clock skips", () => {
    process.env.TZ = "Europe/London";
    expect(errorText(parseDateRange("2026-03-29T01:30", undefined))).toContain(
      "That local time doesn't exist, because the clock changes then.",
    );
  });

  it("refuses a start in the future when the end defaults to now", () => {
    expect(
      errorText(
        parseDateRange("2999-01-01", undefined, { endDefaultsToNow: true }),
      ),
    ).toBe("Error: start_date is in the future.");
  });
});

describe("tool results", () => {
  it("marks a refusal as an error and an answer as not", async () => {
    const { errorResult, textResult, validateResolution, handleApiError } =
      await import("../../src/shared/_helpers.js");
    const { ServerError } = await import("@revolut/revolut-x-api");

    expect(errorResult("no").isError).toBe(true);
    expect(textResult("yes").isError).toBeUndefined();
    expect(validateResolution("7m")?.isError).toBe(true);
    expect(
      (await handleApiError(new ServerError("down", 503), "guide"))?.isError,
    ).toBe(true);
  });

  it("marks a date refusal as an error", async () => {
    const { parseDateRange } = await import("../../src/shared/_helpers.js");

    const result = parseDateRange("not a date", undefined);

    expect("error" in result && result.error.isError).toBe(true);
  });
});
