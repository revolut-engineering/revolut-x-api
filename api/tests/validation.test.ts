import { describe, it, expect } from "vitest";
import {
  priceSchema,
  quantitySchema,
  symbolSchema,
  placeOrderSchema,
  replaceOrderSchema,
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

  it("accepts limit order with timeInForce", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      limit: {
        price: "95000",
        baseSize: "0.001",
        timeInForce: "ioc",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid timeInForce value in limit order", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      limit: {
        price: "95000",
        baseSize: "0.001",
        timeInForce: "invalid",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects fok as timeInForce in limit order", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      limit: {
        price: "95000",
        baseSize: "0.001",
        timeInForce: "fok",
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts conditional order with baseSize", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      conditional: {
        triggerPrice: "100000",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts conditional order with quoteSize and limitPrice", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      conditional: {
        triggerPrice: "90000",
        limitPrice: "89900",
        quoteSize: "100",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects conditional order without size", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      conditional: {
        triggerPrice: "100000",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects conditional order with both sizes", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      conditional: {
        triggerPrice: "100000",
        baseSize: "0.001",
        quoteSize: "100",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects conditional order without triggerPrice", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      conditional: {
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects conditional order with zero triggerPrice", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      conditional: {
        triggerPrice: "0",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts tpsl order with both takeProfit and stopLoss", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      tpsl: {
        baseSize: "0.001",
        takeProfit: { triggerPrice: "110000" },
        stopLoss: { triggerPrice: "90000" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tpsl order with only takeProfit and limitPrice", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      tpsl: {
        baseSize: "0.001",
        takeProfit: { triggerPrice: "110000", limitPrice: "109900" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tpsl order with only stopLoss", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      tpsl: {
        baseSize: "0.001",
        stopLoss: { triggerPrice: "90000" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects tpsl order without takeProfit and stopLoss", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      tpsl: {
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tpsl order without baseSize", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      tpsl: {
        takeProfit: { triggerPrice: "110000" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tpsl leg with zero triggerPrice", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "sell",
      tpsl: {
        baseSize: "0.001",
        takeProfit: { triggerPrice: "0" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects order with limit and tpsl configurations", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      limit: { price: "95000", baseSize: "0.001" },
      tpsl: {
        baseSize: "0.001",
        takeProfit: { triggerPrice: "110000" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects order with market and conditional configurations", () => {
    const result = placeOrderSchema.safeParse({
      symbol: "BTC-USD",
      side: "buy",
      market: { baseSize: "0.001" },
      conditional: {
        triggerPrice: "100000",
        baseSize: "0.001",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("replaceOrderSchema", () => {
  it("accepts replace with timeInForce alongside other fields", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      price: "95000",
      timeInForce: "gtc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts replace with only timeInForce", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      timeInForce: "ioc",
    });
    expect(result.success).toBe(true);
  });

  it("rejects fok as timeInForce for replace", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      timeInForce: "fok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid timeInForce value", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      timeInForce: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects replace with only clientOrderId", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
    });
    expect(result.success).toBe(false);
  });

  it("accepts replace with conditional trigger", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      conditional: { triggerPrice: "100000", limitPrice: "99500" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts replace with conditional trigger without limitPrice", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      conditional: { triggerPrice: "100000" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts replace with take profit and stop loss triggers", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      baseSize: "0.001",
      takeProfit: { triggerPrice: "115000", limitPrice: "114900" },
      stopLoss: { triggerPrice: "90000" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts replace with explicit null trigger removal", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      takeProfit: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects replace trigger without triggerPrice", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      conditional: { limitPrice: "99500" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects replace trigger with zero triggerPrice", () => {
    const result = replaceOrderSchema.safeParse({
      clientOrderId: "client-123",
      takeProfit: { triggerPrice: "0" },
    });
    expect(result.success).toBe(false);
  });
});
