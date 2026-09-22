import { describe, it, expect, vi } from "vitest";
import type { RevolutXClient } from "@revolut/revolut-x-api";
import {
  TickerPriceProvider,
  resolveTickerPrice,
} from "../src/shared/price-source/index.js";

function providerWithTickers(pair: string, data: unknown[]) {
  const getTickers = vi.fn().mockResolvedValue({
    data,
    metadata: { timestamp: 0 },
  });
  const client = { getTickers } as unknown as RevolutXClient;
  const provider = new TickerPriceProvider({ client, pair, intervalSec: 10 });
  return { provider, getTickers };
}

describe("resolveTickerPrice", () => {
  it("uses index price when its drift from mid is below five percent", () => {
    expect(
      resolveTickerPrice({
        mid: "100",
        index_price: "104.99",
        last_price: "99",
      })?.toString(),
    ).toBe("104.99");
  });

  it("uses index price when its drift from mid is exactly five percent", () => {
    expect(
      resolveTickerPrice({
        mid: "100",
        index_price: "95",
        last_price: "99",
      })?.toString(),
    ).toBe("95");
  });

  it("falls back to mid when index price drift exceeds five percent", () => {
    expect(
      resolveTickerPrice({
        mid: "100",
        index_price: "105.0001",
        last_price: "99",
      })?.toString(),
    ).toBe("100");
  });

  it("does not use index price without a valid mid comparison", () => {
    expect(
      resolveTickerPrice({
        mid: "",
        index_price: "100",
        last_price: "99",
      })?.toString(),
    ).toBe("99");
  });

  it("ignores invalid and non-positive index prices", () => {
    expect(
      resolveTickerPrice({
        mid: "100",
        index_price: "not-a-number",
        last_price: "99",
      })?.toString(),
    ).toBe("100");
    expect(
      resolveTickerPrice({
        mid: "100",
        index_price: "0",
        last_price: "99",
      })?.toString(),
    ).toBe("100");
  });

  it("uses mid when present", () => {
    expect(
      resolveTickerPrice({ mid: "100", last_price: "99" })?.toString(),
    ).toBe("100");
  });

  it("falls back to last_price when mid is null", () => {
    expect(
      resolveTickerPrice({ mid: null, last_price: "3500" })?.toString(),
    ).toBe("3500");
  });

  it("falls back to last_price when mid is empty or invalid", () => {
    expect(
      resolveTickerPrice({ mid: "", last_price: "3500" })?.toString(),
    ).toBe("3500");
    expect(
      resolveTickerPrice({ mid: "invalid", last_price: "3500" })?.toString(),
    ).toBe("3500");
  });

  it("returns null when both are missing", () => {
    expect(resolveTickerPrice({ mid: null, last_price: null })).toBeNull();
  });

  it("returns null when the value is not numeric", () => {
    expect(resolveTickerPrice({ mid: "not-a-number" })).toBeNull();
  });
});

describe("TickerPriceProvider", () => {
  it("returns the qualified index price for a slash-format symbol", async () => {
    const { provider, getTickers } = providerWithTickers("BTC-EUR", [
      {
        symbol: "BTC/EUR",
        mid: "54665.94",
        index_price: "54670",
        last_price: "54660",
        bid: "54660",
        ask: "54671",
      },
    ]);

    // when
    const price = await provider.peek();

    // then
    expect(price.toString()).toBe("54670");
    expect(getTickers).toHaveBeenCalledWith({ symbols: ["BTC-EUR"] });
  });

  it("next() wraps the price in a tick", async () => {
    const { provider } = providerWithTickers("BTC-EUR", [
      {
        symbol: "BTC/EUR",
        mid: "100",
        index_price: "101",
        last_price: "100",
      },
    ]);

    // when
    const tick = await provider.next();

    // then
    expect(tick?.price.toString()).toBe("101");
  });

  it("falls back to last_price when mid is null", async () => {
    const { provider } = providerWithTickers("ETH-EUR", [
      { symbol: "ETH/EUR", mid: null, last_price: "3500" },
    ]);

    // then
    expect((await provider.peek()).toString()).toBe("3500");
  });

  it("throws when no ticker matches the pair", async () => {
    const { provider } = providerWithTickers("BTC-EUR", [
      { symbol: "ETH/EUR", mid: "3500" },
    ]);

    // then
    await expect(provider.peek()).rejects.toThrow("No ticker data for BTC-EUR");
  });

  it("throws when the price is missing or non-positive", async () => {
    const zero = providerWithTickers("BTC-EUR", [
      { symbol: "BTC/EUR", mid: "0", last_price: "0" },
    ]);
    await expect(zero.provider.peek()).rejects.toThrow("Invalid ticker price");

    const missing = providerWithTickers("BTC-EUR", [
      { symbol: "BTC/EUR", mid: null, last_price: null },
    ]);
    await expect(missing.provider.peek()).rejects.toThrow(
      "Invalid ticker price",
    );
  });
});
