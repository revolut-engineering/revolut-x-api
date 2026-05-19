import { Decimal } from "decimal.js";

interface SimOrder {
  id: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: Decimal; // limit price for limit orders; fill price for market orders
  quoteSize?: Decimal; // for buy limit and market buy
  baseSize?: Decimal; // for sell limit and market sell
}

export interface SimFill {
  price: Decimal;
  quantity: Decimal;
  quoteValue: Decimal;
}

export interface SimOrderSeed {
  id: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: Decimal;
  quoteSize?: Decimal;
  baseSize?: Decimal;
}

let _idCounter = 0;

function nextId(): string {
  return `sim-order-${++_idCounter}`;
}

export class SimulatedExchange {
  private _orders = new Map<string, SimOrder>();
  private _currentPrice: Decimal = new Decimal(0);
  private _filledBuysThisTick: SimFill[] = [];
  private _filledSellsThisTick: SimFill[] = [];
  private _cashBalance: Decimal = new Decimal(0);

  /** Must be called before constructing to avoid ID collisions across instances */
  static resetIdCounter(): void {
    _idCounter = 0;
  }

  readonly isAuthenticated = true;

  setPrice(price: Decimal): void {
    this._currentPrice = price;
  }

  setCashBalance(balance: Decimal): void {
    this._cashBalance = balance;
  }

  resetTickFills(): void {
    this._filledBuysThisTick = [];
    this._filledSellsThisTick = [];
  }

  get filledBuys(): SimFill[] {
    return this._filledBuysThisTick;
  }

  get filledSells(): SimFill[] {
    return this._filledSellsThisTick;
  }

  get cashBalance(): Decimal {
    return this._cashBalance;
  }

  /**
   * Directly seed an order into the order book without going through placeOrder.
   * Used to set up initial state before the bot starts ticking.
   */
  seedOrder(order: SimOrderSeed): void {
    this._orders.set(order.id, {
      id: order.id,
      side: order.side,
      type: order.type,
      price: order.price,
      quoteSize: order.quoteSize,
      baseSize: order.baseSize,
    });
  }

  // ── Exchange API methods ──────────────────────────────────────────────────

  async placeOrder(params: {
    symbol?: string;
    side: "buy" | "sell";
    limit?: {
      price: string;
      quoteSize?: string;
      baseSize?: string;
      executionInstructions?: string[];
    };
    market?: {
      quoteSize?: string;
      baseSize?: string;
    };
  }): Promise<{ data: { venue_order_id: string } }> {
    const id = nextId();

    if (params.limit) {
      const price = new Decimal(params.limit.price);
      const order: SimOrder = {
        id,
        side: params.side,
        type: "limit",
        price,
        quoteSize: params.limit.quoteSize
          ? new Decimal(params.limit.quoteSize)
          : undefined,
        baseSize: params.limit.baseSize
          ? new Decimal(params.limit.baseSize)
          : undefined,
      };
      this._orders.set(id, order);
    } else if (params.market) {
      // Market orders fill immediately at currentPrice
      const fillPrice = this._currentPrice;
      const order: SimOrder = {
        id,
        side: params.side,
        type: "market",
        price: fillPrice,
        quoteSize: params.market.quoteSize
          ? new Decimal(params.market.quoteSize)
          : undefined,
        baseSize: params.market.baseSize
          ? new Decimal(params.market.baseSize)
          : undefined,
      };
      this._orders.set(id, order);

      // Record market fill immediately
      if (params.side === "buy" && order.quoteSize) {
        const qty = order.quoteSize
          .div(fillPrice)
          .toDecimalPlaces(5, Decimal.ROUND_DOWN);
        this._filledBuysThisTick.push({
          price: fillPrice,
          quantity: qty,
          quoteValue: order.quoteSize,
        });
        this._cashBalance = this._cashBalance.minus(order.quoteSize);
      } else if (params.side === "sell" && order.baseSize) {
        const quoteReceived = order.baseSize
          .times(fillPrice)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN);
        this._filledSellsThisTick.push({
          price: fillPrice,
          quantity: order.baseSize,
          quoteValue: quoteReceived,
        });
        this._cashBalance = this._cashBalance.plus(quoteReceived);
      }
    }

    return { data: { venue_order_id: id } };
  }

  async cancelOrder(id: string): Promise<void> {
    this._orders.delete(id);
  }

  async getActiveOrders(): Promise<{
    data: Array<{ id: string }>;
    metadata: Record<string, unknown>;
  }> {
    const active: Array<{ id: string }> = [];
    for (const [id, order] of this._orders) {
      if (!this._isFilled(order)) {
        active.push({ id });
      }
    }
    return { data: active, metadata: {} };
  }

  async getOrder(id: string): Promise<{
    data: {
      id: string;
      status: string;
      filled_quantity: string;
      filled_amount: string;
      total_fee: string;
      fee_currency: string;
    };
  }> {
    const order = this._orders.get(id);
    if (!order || !this._isFilled(order)) {
      return {
        data: {
          id,
          status: "open",
          filled_quantity: "0",
          filled_amount: "0",
          total_fee: "0",
          fee_currency: "USD",
        },
      };
    }

    // Order is filled — compute quantities
    let filledQuantity: Decimal;
    let filledAmount: Decimal;

    if (order.side === "buy") {
      const quoteSize = order.quoteSize ?? new Decimal(0);
      filledQuantity = quoteSize
        .div(order.price)
        .toDecimalPlaces(5, Decimal.ROUND_DOWN);
      filledAmount = quoteSize;

      // Track fill for this tick (limit buys only — market fills tracked at placement)
      if (order.type === "limit") {
        this._filledBuysThisTick.push({
          price: order.price,
          quantity: filledQuantity,
          quoteValue: quoteSize,
        });
        this._cashBalance = this._cashBalance.minus(quoteSize);
      }
    } else {
      const baseSize = order.baseSize ?? new Decimal(0);
      filledQuantity = baseSize;
      filledAmount = baseSize
        .times(order.price)
        .toDecimalPlaces(2, Decimal.ROUND_DOWN);

      // Track fill for this tick (limit sells only — market fills tracked at placement)
      if (order.type === "limit") {
        this._filledSellsThisTick.push({
          price: order.price,
          quantity: filledQuantity,
          quoteValue: filledAmount,
        });
        this._cashBalance = this._cashBalance.plus(filledAmount);
      }
    }

    // Remove from open orders after querying (the bot won't re-query it)
    this._orders.delete(id);

    return {
      data: {
        id,
        status: "filled",
        filled_quantity: filledQuantity.toString(),
        filled_amount: filledAmount.toString(),
        total_fee: "0",
        fee_currency: "USD",
      },
    };
  }

  async getBalances(): Promise<Array<{ currency: string; available: string }>> {
    return [
      { currency: "USD", available: "99999999" },
      { currency: "BTC", available: "0" },
    ];
  }

  async getCurrencyPairs(): Promise<Record<string, unknown>> {
    return {};
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _isFilled(order: SimOrder): boolean {
    if (order.type === "market") return true; // market orders always "filled"
    if (order.side === "buy") {
      // Buy limit fills when price drops to or below limit price
      return this._currentPrice.lte(order.price);
    } else {
      // Sell limit fills when price rises to or above limit price
      return this._currentPrice.gte(order.price);
    }
  }
}
