import { describe, it, expect } from "vitest";
import {
  priceSchema,
  quantitySchema,
  symbolSchema,
  placeOrderSchema,
} from "../src/validation/schemas.js";

describe("priceSchema", () => {
  it("accepts valid positive price", () => {
    expect(priceSchema.safeParse("100.50").success).toBe(true);
    expect(priceSchema.safeParse("0.001").success).toBe(true);
  });

  it("rejects zero", () => {
    const result = priceSchema.safeParse("0");
    expect(result.success).toBe(false);
  });

  it("rejects negative numbers", () => {
    const result = priceSchema.safeParse("-10");
    expect(result.success).toBe(false);
  });

  it("rejects invalid strings", () => {
    const result = priceSchema.safeParse("not-a-number");
    expect(result.success).toBe(false);
  });
});

describe("quantitySchema", () => {
  it("accepts valid positive quantity", () => {
    expect(quantitySchema.safeParse("0.5").success).toBe(true);
    expect(quantitySchema.safeParse("1000").success).toBe(true);
  });

  it("rejects zero", () => {
    const result = quantitySchema.safeParse("0");
    expect(result.success).toBe(false);
  });

  it("rejects negative numbers", () => {
    const result = quantitySchema.safeParse("-5");
    expect(result.success).toBe(false);
  });
});

describe("symbolSchema", () => {
  it("accepts valid symbols", () => {
    expect(symbolSchema.safeParse("BTC-USD").success).toBe(true);
    expect(symbolSchema.safeParse("ETH-EUR").success).toBe(true);
    expect(symbolSchema.safeParse("SOL-USDT").success).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(symbolSchema.safeParse("BTCUSD").success).toBe(false);
    expect(symbolSchema.safeParse("btc-usd").success).toBe(false);
    expect(symbolSchema.safeParse("").success).toBe(false);
  });
});

describe("placeOrderSchema", () => {
  it("accepts valid limit order with baseSize", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      limit: {
        price: "95000",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid limit order with quoteSize", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      limit: {
        price: "95000",
        quoteSize: "100",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid market order", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "ETH-USD",
      side: "buy",
      market: {
        quoteSize: "1000",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts order with clientOrderId", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      clientOrderId: "my-order-123",
      limit: {
        price: "95000",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects order without limit or market", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
    });
    expect(result.success).toBe(false);
  });

  it("rejects limit order without size", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      limit: {
        price: "95000",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects market order without size", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      market: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid side", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "hold",
      limit: {
        price: "95000",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid symbol format", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "btc-usd",
      side: "buy",
      limit: {
        price: "95000",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative price", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      limit: {
        price: "-100",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(false);
  });
});
