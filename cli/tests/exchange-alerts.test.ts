import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError, ForbiddenError } from "@revolut/revolut-x-api";

const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.mock("@revolut/revolut-x-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@revolut/revolut-x-api")>()),
  loadConfig: mockLoadConfig,
}));

const {
  noDataMessage,
  recoveryMessage,
  refusedKeyMessage,
  refusedKeyNotice,
  savedKeyLabel,
} = await import("../src/engine/exchange-alerts.js");

const SAVED_KEY = `u8jz${"x".repeat(56)}mxgJ`;

beforeEach(() => {
  mockLoadConfig.mockReset();
  mockLoadConfig.mockReturnValue({ api_key: SAVED_KEY });
});

describe("savedKeyLabel", () => {
  it("masks the saved key", () => {
    expect(savedKeyLabel()).toBe("u8jz****mxgJ");
  });

  it("gives no label when no key can be read", () => {
    // given
    mockLoadConfig.mockImplementation(() => {
      throw new Error("EACCES");
    });

    // then
    expect(savedKeyLabel()).toBeNull();
  });
});

describe("refusedKeyMessage", () => {
  it("names the key, the status and a restart after revx configure for a 401", () => {
    // when
    const message = refusedKeyMessage(
      "Grid Bot BTC-USD",
      new AuthenticationError("Unable to resolve API key"),
      {
        user: "grid",
        keyLabel: "u8jz****mxgJ",
        meanwhile: "Open grid orders stay on the exchange meanwhile.",
      },
    );

    // then
    expect(message).toBe(
      "Grid Bot BTC-USD: Revolut X refused the API key u8jz****mxgJ with 401 Unable to resolve API key. Check the API key and the private key with revx configure, then start the grid again. Open grid orders stay on the exchange meanwhile.",
    );
  });

  it("gives the permission advice for a 403 found behind a wrapped error", () => {
    // when
    const message = refusedKeyMessage(
      "Monitor Price Threshold BTC-USD",
      new Error("Failed to fetch ticker", {
        cause: new ForbiddenError("Forbidden."),
      }),
      { user: "monitor", keyLabel: null },
    );

    // then
    expect(message).toBe(
      "Monitor Price Threshold BTC-USD: Revolut X refused the API key with 403 Forbidden. Check that the public key is added in Revolut X, that the key has the permissions it needs and that 'Allow usage via Revolut X MCP and CLI' is ticked. The monitor goes on by itself once the key works.",
    );
  });

  it("leaves out a reason that only repeats the status", () => {
    expect(
      refusedKeyMessage(
        "Grid Bot BTC-USD",
        new AuthenticationError("HTTP 401"),
        { user: "grid", keyLabel: null },
      ),
    ).toContain("refused the API key with 401. Check");
  });
});

describe("refusedKeyNotice", () => {
  it.each([
    [
      new AuthenticationError("Unauthorized"),
      "Revolut X refused the API key with 401 Unauthorized. Check it with revx configure, then start the grid again.",
    ],
    [
      new ForbiddenError("Forbidden"),
      "Revolut X refused the API key with 403 Forbidden. Check its permissions in Revolut X.",
    ],
  ])("gives short advice for %s", (err, notice) => {
    expect(refusedKeyNotice(err, "grid")).toBe(notice);
  });
});

describe("noDataMessage", () => {
  it("says how long and the last error", () => {
    expect(
      noDataMessage(
        "Grid Bot BTC-USD",
        5,
        "Failed to fetch ticker: fetch failed",
      ),
    ).toBe(
      "Grid Bot BTC-USD: no data from Revolut X for 5 minutes. Still trying.\nLast error: Failed to fetch ticker: fetch failed",
    );
  });
});

describe("recoveryMessage", () => {
  it.each([
    [{ fault: "refused", minutes: 3 }, "Revolut X accepts the API key again."],
    [
      { fault: "unreachable", minutes: 7 },
      "data from Revolut X is back after 7 minutes.",
    ],
    [
      { fault: "unreachable", minutes: 1 },
      "data from Revolut X is back after 1 minute.",
    ],
  ] as const)("says what came back for %o", (alert, text) => {
    expect(recoveryMessage("Grid Bot BTC-USD", alert)).toBe(
      `Grid Bot BTC-USD: ${text}`,
    );
  });
});
