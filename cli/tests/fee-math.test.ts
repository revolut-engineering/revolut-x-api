import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import type { OrderDetails } from "@revolut/revolut-x-api";

import { buyEconomics, sellEconomics } from "../src/engine/fee-math.js";

const PAIR = "BTC-USD";
const PRICE = new Decimal("78737.18");

const GROSS_BASE = "0.00635024";
const NET_BASE = "0.00634452";
const QUOTE = "500.00";
const BASE_FEE = "0.00000572";

function order(fields: Record<string, string>): OrderDetails {
  return {
    id: "order-1",
    status: "filled",
    filled_quantity: GROSS_BASE,
    filled_amount: QUOTE,
    ...fields,
  } as unknown as OrderDetails;
}

describe("fee math", () => {
  it("keeps a base-denominated buy fee out of the cost basis", () => {
    // given
    const filled = order({ total_fee: BASE_FEE, fee_currency: "BTC" });

    // when
    const { baseReceived, quoteCost, feeQuote } = buyEconomics(
      filled,
      PRICE,
      PAIR,
    );

    // then
    expect(baseReceived.toString()).toBe(NET_BASE);
    expect(quoteCost.toString()).toBe("500");
    expect(feeQuote.toFixed(2)).toBe("0.45");
  });

  it("puts a quote-denominated buy fee into the cost basis", () => {
    // given
    const filled = order({ total_fee: "0.45", fee_currency: "USD" });

    // when
    const { baseReceived, quoteCost, feeQuote } = buyEconomics(
      filled,
      PRICE,
      PAIR,
    );

    // then
    expect(baseReceived.toString()).toBe(GROSS_BASE);
    expect(quoteCost.toString()).toBe("500.45");
    expect(feeQuote.toString()).toBe("0.45");
  });

  it("charges a buy fee exactly once whichever side it lands on", () => {
    // given
    const inBase = buyEconomics(
      order({ total_fee: BASE_FEE, fee_currency: "BTC" }),
      PRICE,
      PAIR,
    );
    const inQuote = buyEconomics(
      order({ total_fee: "0.45", fee_currency: "USD" }),
      PRICE,
      PAIR,
    );

    // then
    const unitCostBase = inBase.quoteCost.div(inBase.baseReceived);
    const unitCostQuote = inQuote.quoteCost.div(inQuote.baseReceived);
    expect(unitCostBase.minus(unitCostQuote).abs().lt(1)).toBe(true);
    expect(unitCostBase.gt(PRICE)).toBe(true);
    expect(unitCostQuote.gt(PRICE)).toBe(true);
  });

  it("leaves a fee-free fill untouched", () => {
    // given
    const filled = order({ total_fee: "0", fee_currency: "USD" });

    // when
    const { baseReceived, quoteCost, feeQuote } = buyEconomics(
      filled,
      PRICE,
      PAIR,
    );

    // then
    expect(baseReceived.toString()).toBe(GROSS_BASE);
    expect(quoteCost.toString()).toBe("500");
    expect(feeQuote.isZero()).toBe(true);
  });

  it("nets a quote-denominated sell fee off the proceeds", () => {
    // given
    const filled = order({ total_fee: "0.45", fee_currency: "USD" });

    // when
    const { baseDelivered, quoteProceeds } = sellEconomics(filled, PRICE, PAIR);

    // then
    expect(baseDelivered.toString()).toBe(GROSS_BASE);
    expect(quoteProceeds.toString()).toBe("499.55");
  });

  it("adds a base-denominated sell fee to the base delivered", () => {
    // given
    const filled = order({ total_fee: BASE_FEE, fee_currency: "BTC" });

    // when
    const { baseDelivered, quoteProceeds } = sellEconomics(filled, PRICE, PAIR);

    // then
    expect(baseDelivered.toString()).toBe("0.00635596");
    expect(quoteProceeds.toString()).toBe("500");
  });

  it("ignores a fee charged in an unrelated currency", () => {
    // given
    const filled = order({ total_fee: "0.45", fee_currency: "EUR" });

    // when
    const { baseReceived, quoteCost, feeQuote } = buyEconomics(
      filled,
      PRICE,
      PAIR,
    );

    // then
    expect(baseReceived.toString()).toBe(GROSS_BASE);
    expect(quoteCost.toString()).toBe("500");
    expect(feeQuote.isZero()).toBe(true);
  });
});
