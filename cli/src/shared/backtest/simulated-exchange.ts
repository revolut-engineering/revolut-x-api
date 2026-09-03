import { Decimal } from "decimal.js";
import { floorToStep } from "../../engine/grid-plan.js";
import { MAKER_FEE_RATE, TAKER_FEE_RATE } from "../../engine/grid-math.js";

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
  private readonly _cancelledOrderIds = new Set<string>();
  private readonly _baseStep: Decimal;
  private readonly _quoteStep: Decimal;
  private readonly _baseCurrency: string;
  private readonly _quoteCurrency: string;

  constructor(
    baseStep = new Decimal("0.00001"),
    quoteStep = new Decimal("0.01"),
    baseCurrency = "BTC",
    quoteCurrency = "USD",
  ) {
    this._baseStep = baseStep;
    this._quoteStep = quoteStep;
    this._baseCurrency = baseCurrency;
    this._quoteCurrency = quoteCurrency;
  }

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
        const qty = floorToStep(order.quoteSize.div(fillPrice), this._baseStep);
        this._filledBuysThisTick.push({
          price: fillPrice,
          quantity: qty.minus(qty.times(TAKER_FEE_RATE)),
          quoteValue: order.quoteSize,
        });
        this._cashBalance = this._cashBalance.minus(order.quoteSize);
      } else if (params.side === "sell" && order.baseSize) {
        const grossQuote = floorToStep(
          order.baseSize.times(fillPrice),
          this._quoteStep,
        );
        const quoteReceived = grossQuote.minus(
          grossQuote.times(TAKER_FEE_RATE),
        );
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
    this._cancelledOrderIds.add(id);
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
    if (this._cancelledOrderIds.has(id)) {
      return {
        data: {
          id,
          status: "cancelled",
          filled_quantity: "0",
          filled_amount: "0",
          total_fee: "0",
          fee_currency: this._quoteCurrency,
        },
      };
    }
    const order = this._orders.get(id);
    if (!order || !this._isFilled(order)) {
      return {
        data: {
          id,
          status: "open",
          filled_quantity: "0",
          filled_amount: "0",
          total_fee: "0",
          fee_currency: this._quoteCurrency,
        },
      };
    }

    // Order is filled — compute quantities
    let filledQuantity: Decimal;
    let filledAmount: Decimal;

    if (order.side === "buy") {
      const quoteSize = order.quoteSize ?? new Decimal(0);
      filledQuantity = floorToStep(quoteSize.div(order.price), this._baseStep);
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
      filledAmount = floorToStep(baseSize.times(order.price), this._quoteStep);

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

    const feeRate = order.type === "market" ? TAKER_FEE_RATE : MAKER_FEE_RATE;
    const fee = (order.side === "buy" ? filledQuantity : filledAmount).times(
      feeRate,
    );
    const feeCurrency =
      order.side === "buy" ? this._baseCurrency : this._quoteCurrency;

    return {
      data: {
        id,
        status: "filled",
        filled_quantity: filledQuantity.toString(),
        filled_amount: filledAmount.toString(),
        total_fee: fee.toString(),
        fee_currency: feeCurrency,
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
