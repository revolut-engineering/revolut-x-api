import { Decimal } from "decimal.js";
import type { OrderDetails } from "@revolut/revolut-x-api";

export interface BuyEconomics {
  baseReceived: Decimal;
  quoteCost: Decimal;
  feeQuote: Decimal;
}

export interface SellEconomics {
  baseDelivered: Decimal;
  quoteProceeds: Decimal;
  feeQuote: Decimal;
}

function currencies(pair: string): [string, string] {
  const [base, quote] = pair.split("-");
  return [base ?? "", quote ?? ""];
}

function rawFee(order: OrderDetails): Decimal {
  return order.total_fee ? new Decimal(order.total_fee) : new Decimal(0);
}

export function executionPrice(
  order: OrderDetails,
  fallbackPrice: Decimal,
): Decimal {
  for (const rawPrice of [order.average_fill_price, order.price]) {
    if (!rawPrice) continue;
    try {
      const price = new Decimal(rawPrice);
      if (price.isFinite() && price.gt(0)) return price;
    } catch {}
  }
  return fallbackPrice;
}

export function averageFillPrice(
  order: OrderDetails,
  fallbackPrice: Decimal,
): Decimal {
  if (order.average_fill_price) {
    try {
      const price = new Decimal(order.average_fill_price);
      if (price.isFinite() && price.gt(0)) return price;
    } catch {}
  }
  const filledQty = new Decimal(order.filled_quantity || 0);
  if (order.filled_amount && filledQty.gt(0)) {
    return new Decimal(order.filled_amount).div(filledQty);
  }
  return fallbackPrice;
}

export function filledAmount(
  order: OrderDetails,
  fallbackPrice: Decimal,
): Decimal {
  if (order.filled_amount) return new Decimal(order.filled_amount);
  return new Decimal(order.filled_quantity).times(
    executionPrice(order, fallbackPrice),
  );
}

export function feeSide(
  order: OrderDetails,
  pair: string,
): "base" | "quote" | null {
  if (!rawFee(order).gt(0)) return null;
  const [baseCurrency, quoteCurrency] = currencies(pair);
  if (order.fee_currency === baseCurrency) return "base";
  if (order.fee_currency === quoteCurrency) return "quote";
  return null;
}

export function feeQuote(
  order: OrderDetails,
  fallbackPrice: Decimal,
  pair: string,
): Decimal {
  const fee = rawFee(order);
  if (fee.isZero()) return new Decimal(0);
  const side = feeSide(order, pair);
  if (side === "quote") return fee;
  if (side === "base") {
    const filledQty = new Decimal(order.filled_quantity);
    const amount = filledAmount(order, fallbackPrice);
    const price = filledQty.gt(0) ? amount.div(filledQty) : fallbackPrice;
    return fee.times(price);
  }
  return new Decimal(0);
}

export function netBase(order: OrderDetails, pair: string): Decimal {
  const filledQty = new Decimal(order.filled_quantity);
  if (feeSide(order, pair) === "base") {
    return Decimal.max(new Decimal(0), filledQty.minus(rawFee(order)));
  }
  return filledQty;
}

export function buyEconomics(
  order: OrderDetails,
  fallbackPrice: Decimal,
  pair: string,
): BuyEconomics {
  const fee = feeQuote(order, fallbackPrice, pair);
  const amount = filledAmount(order, fallbackPrice);
  if (feeSide(order, pair) === "base") {
    return {
      baseReceived: netBase(order, pair),
      quoteCost: amount,
      feeQuote: fee,
    };
  }
  return {
    baseReceived: new Decimal(order.filled_quantity),
    quoteCost: amount.plus(fee),
    feeQuote: fee,
  };
}

export function sellEconomics(
  order: OrderDetails,
  fallbackPrice: Decimal,
  pair: string,
): SellEconomics {
  const fee = feeQuote(order, fallbackPrice, pair);
  const amount = filledAmount(order, fallbackPrice);
  const filledQty = new Decimal(order.filled_quantity);
  if (feeSide(order, pair) === "base") {
    return {
      baseDelivered: filledQty.plus(rawFee(order)),
      quoteProceeds: amount,
      feeQuote: fee,
    };
  }
  return {
    baseDelivered: filledQty,
    quoteProceeds: amount.minus(fee),
    feeQuote: fee,
  };
}
