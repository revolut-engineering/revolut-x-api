import { describe, it, expect } from "vitest";
import { MAKER_FEE_RATE, TAKER_FEE_RATE } from "../../src/index.js";
import { createTestClient } from "../helpers/test-utils.js";

describe("Fees", () => {
  it("exposes the venue fee rates on the client", () => {
    const client = createTestClient();

    expect(client.getMakerFee()).toBe(MAKER_FEE_RATE);
    expect(client.getTakerFee()).toBe(TAKER_FEE_RATE);
  });

  it("reads fees without credentials", () => {
    const client = createTestClient({ authenticated: false });

    expect(client.isAuthenticated).toBe(false);
    expect(client.getMakerFee()).toBe("0");
    expect(client.getTakerFee()).toBe("0.0009");
  });

  it("returns rates that parse exactly", () => {
    expect(Number(MAKER_FEE_RATE)).toBe(0);
    expect(Number(TAKER_FEE_RATE) * 10_000).toBeCloseTo(9, 10);
  });
});
