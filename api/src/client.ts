import type { KeyObject } from "node:crypto";
import { randomUUID } from "node:crypto";
import { makeRequest, type RequestOptions } from "./http/index.js";
import { AuthNotConfiguredError, ValidationError } from "./http/errors.js";
import { loadPrivateKey } from "./auth/keypair.js";
import { loadCredentials } from "./auth/index.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "./config/settings.js";
import { type LogCallback, Logger } from "./logging/logger.js";
import { placeOrderSchema } from "./validation/schemas.js";
import type { AccountBalance } from "./types/account.js";
import type { CurrencyMap, CurrencyPairMap } from "./types/config.js";
import type {
  ActiveOrdersOptions,
  HistoricalOrdersOptions,
  Order,
  OrderPlacementResult,
  PlaceOrderParams,
} from "./types/orders.js";
import type { PublicTrade, Trade, TradesOptions } from "./types/trades.js";
import {
  mapPublicTrade,
  mapTrade,
  type WirePublicTrade,
  type WireTrade,
} from "./mappers/trades.js";
import {
  mapOrderBookLevel,
  type WireOrderBookLevel,
} from "./mappers/market.js";
import type {
  Candle,
  CandlesOptions,
  OrderBook,
  OrderBookLevel,
  OrderBookOptions,
  Ticker,
  TickersOptions,
} from "./types/market.js";
import type {
  DataArrayResponse,
  DataResponse,
  PaginatedResponse,
} from "./types/common.js";

const RESOLUTION_MAP: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "2d": 2880,
  "4d": 5760,
  "1w": 10080,
  "2w": 20160,
  "4w": 40320,
};

export interface RevolutXClientOptions {
  apiKey?: string;
  privateKey?: KeyObject;
  privateKeyPath?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  autoLoadCredentials?: boolean;
  logger?: LogCallback;
}

export class RevolutXClient {
  private readonly requestOptions: RequestOptions;
  private readonly logger: Logger;

  constructor(options: RevolutXClientOptions = {}) {
    let apiKey = options.apiKey;
    let privateKey = options.privateKey;

    if (options.privateKeyPath && !privateKey) {
      privateKey = loadPrivateKey(options.privateKeyPath);
    }

    if (!apiKey && !privateKey && options.autoLoadCredentials !== false) {
      const credentials = loadCredentials();
      if (credentials) {
        apiKey = credentials.apiKey;
        privateKey = credentials.privateKey;
      }
    }

    this.logger = new Logger(options.logger);

    this.requestOptions = {
      baseUrl:
        options.baseUrl ??
        process.env.REVOLUTX_API_URL ??
        "https://revx.revolut.codes",
      apiKey,
      privateKey,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      logger: this.logger,
    };
  }

  get isAuthenticated(): boolean {
    return Boolean(
      this.requestOptions.apiKey && this.requestOptions.privateKey,
    );
  }

  private requireAuth(): void {
    if (!this.isAuthenticated) {
      throw new AuthNotConfiguredError();
    }
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return (await makeRequest(
      this.requestOptions,
      method,
      path,
      params,
      body,
    )) as T;
  }

  async getBalances(): Promise<AccountBalance[]> {
    this.requireAuth();
    return this.request<AccountBalance[]>("GET", "/balances");
  }

  async getCurrencies(): Promise<CurrencyMap> {
    this.requireAuth();
    return this.request<CurrencyMap>("GET", "/configuration/currencies");
  }

  async getCurrencyPairs(): Promise<CurrencyPairMap> {
    this.requireAuth();
    return this.request<CurrencyPairMap>("GET", "/configuration/pairs");
  }

  async getTickers(
    opts?: TickersOptions,
  ): Promise<{ data: Ticker[]; metadata: { timestamp: number } }> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.symbols?.length) params.symbols = opts.symbols.join(",");
    return this.request<{ data: Ticker[]; metadata: { timestamp: number } }>(
      "GET",
      "/tickers",
      params,
    );
  }

  async getCandles(
    symbol: string,
    opts?: CandlesOptions,
  ): Promise<DataArrayResponse<Candle>> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.interval !== undefined) {
      params.interval =
        typeof opts.interval === "number"
          ? opts.interval
          : (RESOLUTION_MAP[String(opts.interval)] ?? opts.interval);
    }
    if (opts?.startDate !== undefined) params.since = opts.startDate;
    if (opts?.endDate !== undefined) params.until = opts.endDate;
    return this.request<DataArrayResponse<Candle>>(
      "GET",
      `/candles/${symbol}`,
      params,
    );
  }

  async getOrderBook(
    symbol: string,
    opts?: OrderBookOptions,
  ): Promise<{
    data: OrderBook<OrderBookLevel>;
    metadata: { timestamp: number };
  }> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.limit !== undefined) params.limit = opts.limit;
    const raw = await this.request<{
      data: OrderBook<WireOrderBookLevel>;
      metadata: { timestamp: number };
    }>("GET", `/order-book/${symbol}`, params);
    return {
      data: {
        asks: raw.data.asks.map(mapOrderBookLevel),
        bids: raw.data.bids.map(mapOrderBookLevel),
      },
      metadata: raw.metadata,
    };
  }

  async placeOrder(
    params: PlaceOrderParams,
  ): Promise<DataResponse<OrderPlacementResult>> {
    this.requireAuth();

    const validation = placeOrderSchema.safeParse(params);
    if (!validation.success) {
      throw new ValidationError(
        "Invalid order parameters",
        validation.error.errors,
      );
    }
    const body: Record<string, unknown> = {
      client_order_id: params.clientOrderId ?? randomUUID(),
      symbol: params.symbol,
      side: params.side,
    };

    if (params.limit) {
      const limitConfig: Record<string, unknown> = {
        price: params.limit.price,
      };
      if (params.limit.baseSize) limitConfig.base_size = params.limit.baseSize;
      if (params.limit.quoteSize)
        limitConfig.quote_size = params.limit.quoteSize;
      if (params.limit.executionInstructions) {
        limitConfig.execution_instructions = params.limit.executionInstructions;
      }
      body.order_configuration = { limit: limitConfig };
    } else if (params.market) {
      const marketConfig: Record<string, unknown> = {};
      if (params.market.baseSize)
        marketConfig.base_size = params.market.baseSize;
      if (params.market.quoteSize)
        marketConfig.quote_size = params.market.quoteSize;
      body.order_configuration = { market: marketConfig };
    }

    return this.request<DataResponse<OrderPlacementResult>>(
      "POST",
      "/orders",
      undefined,
      body,
    );
  }

  async getActiveOrders(
    opts?: ActiveOrdersOptions,
  ): Promise<PaginatedResponse<Order>> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.symbols?.length) params.symbols = opts.symbols.join(",");
    if (opts?.orderStates?.length)
      params.order_states = opts.orderStates.join(",");
    if (opts?.orderTypes?.length)
      params.order_types = opts.orderTypes.join(",");
    if (opts?.side) params.side = opts.side;
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    return this.request<PaginatedResponse<Order>>(
      "GET",
      "/orders/active",
      params,
    );
  }

  async getHistoricalOrders(
    opts?: HistoricalOrdersOptions,
  ): Promise<PaginatedResponse<Order>> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.symbols?.length) params.symbols = opts.symbols.join(",");
    if (opts?.orderStates?.length)
      params.order_states = opts.orderStates.join(",");
    if (opts?.orderTypes?.length)
      params.order_types = opts.orderTypes.join(",");
    if (opts?.startDate !== undefined) params.start_date = opts.startDate;
    if (opts?.endDate !== undefined) params.end_date = opts.endDate;
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    return this.request<PaginatedResponse<Order>>(
      "GET",
      "/orders/historical",
      params,
    );
  }

  async getOrder(venueOrderId: string): Promise<DataResponse<Order>> {
    this.requireAuth();
    return this.request<DataResponse<Order>>("GET", `/orders/${venueOrderId}`);
  }

  async cancelOrder(venueOrderId: string): Promise<void> {
    this.requireAuth();
    await this.request("DELETE", `/orders/${venueOrderId}`);
  }

  async cancelAllOrders(): Promise<void> {
    this.requireAuth();
    await this.request("DELETE", "/orders");
  }

  async getOrderFills(venueOrderId: string): Promise<DataArrayResponse<Trade>> {
    this.requireAuth();
    const raw = await this.request<DataArrayResponse<WireTrade>>(
      "GET",
      `/orders/fills/${venueOrderId}`,
    );
    return {
      ...raw,
      data: raw.data.map(mapTrade),
    };
  }

  async getAllTrades(
    symbol: string,
    opts?: TradesOptions,
  ): Promise<PaginatedResponse<PublicTrade>> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.startDate !== undefined) params.start_date = opts.startDate;
    if (opts?.endDate !== undefined) params.end_date = opts.endDate;
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    const raw = await this.request<PaginatedResponse<WirePublicTrade>>(
      "GET",
      `/trades/all/${symbol}`,
      params,
    );
    return {
      ...raw,
      data: raw.data.map(mapPublicTrade),
    };
  }

  async getPrivateTrades(
    symbol: string,
    opts?: TradesOptions,
  ): Promise<PaginatedResponse<Trade>> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.startDate !== undefined) params.start_date = opts.startDate;
    if (opts?.endDate !== undefined) params.end_date = opts.endDate;
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    const raw = await this.request<PaginatedResponse<WireTrade>>(
      "GET",
      `/trades/private/${symbol}`,
      params,
    );
    return {
      ...raw,
      data: raw.data.map(mapTrade),
    };
  }
}
