/**
 * Async HTTP client for Revolut X API with signing, rate limiting, and retries.
 */
import type { KeyObject } from "node:crypto";
import { buildAuthHeaders } from "../auth/signer.js";
import { requireCredentials, type Credentials } from "../auth/credentials.js";
import {
  AuthenticationError,
  NetworkError,
  NotFoundError,
  OrderError,
  RateLimitError,
  RevolutXAPIError,
} from "./exceptions.js";
import type { RateLimiter } from "./rate-limiter.js";

const API_PREFIX = "/api/1.0";

export class RevolutXClient {
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;
  private readonly credentials?: Credentials;
  private readonly maxRetries: number;

  constructor(options: {
    baseUrl?: string;
    rateLimiter: RateLimiter;
    credentials?: Credentials;
    maxRetries?: number;
  }) {
    this.baseUrl = (options.baseUrl ?? "https://revx.revolut.com").replace(
      /\/$/,
      "",
    );
    this.rateLimiter = options.rateLimiter;
    this.credentials = options.credentials;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private getCredentials(): Credentials {
    if (this.credentials) return this.credentials;
    return requireCredentials();
  }

  private static raiseForStatus(
    status: number,
    body: string,
  ): void {
    if (status >= 200 && status < 300) return;

    let message: string;
    try {
      const detail = JSON.parse(body);
      message = detail.message ?? detail.error ?? body;
    } catch {
      message = body || `HTTP ${status}`;
    }

    if (status === 401 || status === 403) {
      throw new AuthenticationError(
        `Authentication failed: ${message}. ` +
          "Please verify your API key and that the public key is registered " +
          "in your Revolut X account.",
        status,
      );
    }
    if (status === 429) {
      throw new RateLimitError(
        "Rate limit exceeded. Please wait a moment before retrying.",
        status,
      );
    }
    if (status === 400) {
      throw new OrderError(`Request rejected: ${message}`, status);
    }
    if (status === 404) {
      throw new NotFoundError(`Not found: ${message}`, status);
    }
    throw new RevolutXAPIError(`API error (${status}): ${message}`, status);
  }

  private async _request(
    method: string,
    path: string,
    params?: Record<string, unknown>,
    jsonBody?: Record<string, unknown>,
    isLastTrades: boolean = false,
  ): Promise<unknown> {
    const fullPath = `${API_PREFIX}${path}`;

    // Build sorted query string for signing
    const filteredParams: Record<string, string> = {};
    if (params) {
      const sorted = Object.keys(params).sort();
      for (const key of sorted) {
        const val = params[key];
        if (val !== undefined && val !== null) {
          filteredParams[key] = String(val);
        }
      }
    }
    const queryString = Object.keys(filteredParams).length
      ? new URLSearchParams(filteredParams).toString()
      : "";
    const bodyString = jsonBody ? JSON.stringify(jsonBody) : "";

    const creds = this.getCredentials();

    if (isLastTrades) {
      await this.rateLimiter.acquireLastTrades();
    } else {
      await this.rateLimiter.acquireGeneral();
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const headers: Record<string, string> = buildAuthHeaders(
        creds.apiKey,
        creds.privateKey,
        method.toUpperCase(),
        fullPath,
        queryString,
        bodyString,
      );
      if (jsonBody) {
        headers["Content-Type"] = "application/json";
      }

      const url =
        this.baseUrl +
        fullPath +
        (queryString ? `?${queryString}` : "");

      try {
        const response = await fetch(url, {
          method: method.toUpperCase(),
          headers,
          body: bodyString || undefined,
          signal: AbortSignal.timeout(30_000),
        });

        const responseBody = await response.text();
        RevolutXClient.raiseForStatus(response.status, responseBody);

        if (response.status === 204 || !responseBody) {
          return {};
        }
        return JSON.parse(responseBody);
      } catch (error) {
        if (
          error instanceof AuthenticationError ||
          error instanceof RateLimitError ||
          error instanceof OrderError
        ) {
          throw error;
        }
        if (error instanceof RevolutXAPIError) {
          if (error.statusCode && error.statusCode < 500) {
            throw error;
          }
          lastError = error;
        } else if (
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "TimeoutError")
        ) {
          lastError = new NetworkError(
            `Network error: ${error.constructor.name}. ` +
              "Check your internet connection and try again.",
          );
        } else {
          throw error;
        }
      }

      if (attempt < this.maxRetries - 1) {
        const backoff = 2 ** attempt * 0.5 + Math.random() * 0.5;
        await new Promise((r) => setTimeout(r, backoff * 1000));
      }
    }

    throw lastError ?? new NetworkError("Request failed after retries");
  }

  // ── Public methods ─────────────────────────────────────────────────

  async getCurrencies(): Promise<unknown> {
    return this._request("GET", "/configuration/currencies");
  }

  async getCurrencyPairs(): Promise<unknown> {
    return this._request("GET", "/configuration/pairs");
  }

  async getTickers(): Promise<unknown> {
    return this._request("GET", "/tickers");
  }

  async getOrderBook(
    symbol: string,
    limit: number = 20,
  ): Promise<unknown> {
    return this._request("GET", `/public/order-book/${symbol}`, { limit });
  }

  async getCandles(
    symbol: string,
    resolution: string = "1h",
    start?: number,
    end?: number,
  ): Promise<unknown> {
    const params: Record<string, unknown> = { resolution };
    if (start !== undefined) params.start = start;
    if (end !== undefined) params.end = end;
    return this._request("GET", `/candles/${symbol}`, params);
  }

  async getPublicTrades(
    symbol: string,
    startDate?: number,
    endDate?: number,
    cursor?: string,
    limit: number = 100,
  ): Promise<unknown> {
    const params: Record<string, unknown> = { limit };
    if (startDate !== undefined) params.start_date = startDate;
    if (endDate !== undefined) params.end_date = endDate;
    if (cursor !== undefined) params.cursor = cursor;
    return this._request("GET", `/trades/all/${symbol}`, params);
  }

  async getLastTrades(): Promise<unknown> {
    return this._request(
      "GET",
      "/public/last-trades",
      undefined,
      undefined,
      true,
    );
  }

  async getBalances(): Promise<unknown> {
    return this._request("GET", "/balances");
  }

  async getActiveOrders(): Promise<unknown> {
    return this._request("GET", "/orders/active");
  }

  async placeOrder(
    clientOrderId: string,
    symbol: string,
    side: string,
    orderConfiguration: Record<string, unknown>,
  ): Promise<unknown> {
    return this._request("POST", "/orders", undefined, {
      client_order_id: clientOrderId,
      symbol,
      side,
      order_configuration: orderConfiguration,
    });
  }

  async cancelOrder(venueOrderId: string): Promise<unknown> {
    return this._request("DELETE", `/orders/${venueOrderId}`);
  }

  async getClientTrades(
    symbol: string,
    startDate?: number,
    endDate?: number,
    cursor?: string,
    limit: number = 100,
  ): Promise<unknown> {
    const params: Record<string, unknown> = { limit };
    if (startDate !== undefined) params.start_date = startDate;
    if (endDate !== undefined) params.end_date = endDate;
    if (cursor !== undefined) params.cursor = cursor;
    return this._request("GET", `/trades/private/${symbol}`, params);
  }
}
