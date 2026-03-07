import type { KeyObject } from "node:crypto";
import { randomUUID } from "node:crypto";
import { makeRequest, RateLimiter, type RequestOptions } from "./http/index.js";
import { AuthNotConfiguredError } from "./http/errors.js";
import { loadPrivateKey } from "./auth/keypair.js";
import { loadCredentials } from "./auth/credentials.js";
import type { AccountBalance } from "./types/account.js";
import type { CurrencyMap, CurrencyPairMap } from "./types/config.js";
import type {
  Order,
  OrderPlacementResult,
  PlaceOrderParams,
  ActiveOrdersOptions,
  HistoricalOrdersOptions,
} from "./types/orders.js";
import type { Trade, PublicTrade, TradesOptions } from "./types/trades.js";
import type {
  Ticker,
  TickersOptions,
  Candle,
  CandlesOptions,
  OrderBookLevel,
  OrderBookPublicLevel,
  OrderBook,
  OrderBookOptions,
} from "./types/market.js";
import type {
  PaginatedResponse,
  DataResponse,
  DataArrayResponse,
} from "./types/common.js";

const RESOLUTION_MAP: Record<string, number> = {
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
}

export class RevolutXClient {
  private readonly requestOptions: RequestOptions;

  constructor(options: RevolutXClientOptions = {}) {
    let apiKey = options.apiKey;
    let privateKey = options.privateKey;

    if (options.privateKeyPath && !privateKey) {
      privateKey = loadPrivateKey(options.privateKeyPath);
    }

    if (!apiKey && !privateKey && options.autoLoadCredentials !== false) {
      const creds = loadCredentials();
      if (creds) {
        apiKey = creds.apiKey;
        privateKey = creds.privateKey;
      }
    }

    this.requestOptions = {
      baseUrl:
        options.baseUrl ??
        process.env.REVOLUTX_API_URL ??
        "https://revx.revolut.com",
      apiKey,
      privateKey,
      rateLimiter: new RateLimiter(),
      timeout: options.timeout ?? 30_000,
      maxRetries: options.maxRetries ?? 3,
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

  private async request(
    method: string,
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    isPublic?: boolean,
  ): Promise<unknown> {
    return makeRequest(
      this.requestOptions,
      method,
      path,
      params,
      body,
      isPublic,
    );
  }

  async getBalances(): Promise<AccountBalance[]> {
    this.requireAuth();
    return (await this.request("GET", "/balances")) as AccountBalance[];
  }

  async getCurrencies(): Promise<CurrencyMap> {
    this.requireAuth();
    return (await this.request(
      "GET",
      "/configuration/currencies",
    )) as CurrencyMap;
  }

  async getCurrencyPairs(): Promise<CurrencyPairMap> {
    this.requireAuth();
    return (await this.request(
      "GET",
      "/configuration/pairs",
    )) as CurrencyPairMap;
  }

  async getTickers(
    opts?: TickersOptions,
  ): Promise<{ data: Ticker[]; metadata: { timestamp: number } }> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.symbols?.length) params.symbols = opts.symbols.join(",");
    return (await this.request("GET", "/tickers", params)) as {
      data: Ticker[];
      metadata: { timestamp: number };
    };
  }

  async getCandles(
    symbol: string,
    opts?: CandlesOptions,
  ): Promise<DataArrayResponse<Candle>> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.interval !== undefined) {
      const minutes =
        typeof opts.interval === "number"
          ? opts.interval
          : (RESOLUTION_MAP[String(opts.interval)] ?? opts.interval);
      params.interval = minutes;
    }
    if (opts?.since !== undefined) params.since = opts.since;
    if (opts?.until !== undefined) params.until = opts.until;
    return (await this.request(
      "GET",
      `/candles/${symbol}`,
      params,
    )) as DataArrayResponse<Candle>;
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
    return (await this.request("GET", `/order-book/${symbol}`, params)) as {
      data: OrderBook<OrderBookLevel>;
      metadata: { timestamp: number };
    };
  }

  async getLastTrades(): Promise<{
    data: PublicTrade[];
    metadata: { timestamp: string };
  }> {
    return (await this.request(
      "GET",
      "/public/last-trades",
      undefined,
      undefined,
      true,
    )) as {
      data: PublicTrade[];
      metadata: { timestamp: string };
    };
  }

  async getPublicOrderBook(symbol: string): Promise<{
    data: OrderBook<OrderBookPublicLevel>;
    metadata: { timestamp: string };
  }> {
    return (await this.request(
      "GET",
      `/public/order-book/${symbol}`,
      undefined,
      undefined,
      true,
    )) as {
      data: OrderBook<OrderBookPublicLevel>;
      metadata: { timestamp: string };
    };
  }

  async placeOrder(
    params: PlaceOrderParams,
  ): Promise<DataResponse<OrderPlacementResult>> {
    this.requireAuth();
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

    return (await this.request(
      "POST",
      "/orders",
      undefined,
      body,
    )) as DataResponse<OrderPlacementResult>;
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
    return (await this.request(
      "GET",
      "/orders/active",
      params,
    )) as PaginatedResponse<Order>;
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
    return (await this.request(
      "GET",
      "/orders/historical",
      params,
    )) as PaginatedResponse<Order>;
  }

  async getOrder(venueOrderId: string): Promise<DataResponse<Order>> {
    this.requireAuth();
    return (await this.request(
      "GET",
      `/orders/${venueOrderId}`,
    )) as DataResponse<Order>;
  }

  async cancelOrder(venueOrderId: string): Promise<void> {
    this.requireAuth();
    await this.request("DELETE", `/orders/${venueOrderId}`);
  }

  async getOrderFills(venueOrderId: string): Promise<DataArrayResponse<Trade>> {
    this.requireAuth();
    return (await this.request(
      "GET",
      `/orders/fills/${venueOrderId}`,
    )) as DataArrayResponse<Trade>;
  }

  async getAllTrades(
    symbol: string,
    opts?: TradesOptions,
  ): Promise<PaginatedResponse<Trade>> {
    this.requireAuth();
    const params: Record<string, unknown> = {};
    if (opts?.startDate !== undefined) params.start_date = opts.startDate;
    if (opts?.endDate !== undefined) params.end_date = opts.endDate;
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    return (await this.request(
      "GET",
      `/trades/all/${symbol}`,
      params,
    )) as PaginatedResponse<Trade>;
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
    return (await this.request(
      "GET",
      `/trades/private/${symbol}`,
      params,
    )) as PaginatedResponse<Trade>;
  }
}
