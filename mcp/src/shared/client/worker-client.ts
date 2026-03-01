/**
 * HTTP client for the RevolutX Worker REST API with circuit breaker.
 */
import {
  WorkerUnavailableError,
  WorkerAPIError,
} from "./exceptions.js";

export const WORKER_NOT_RUNNING =
  "The RevolutX Worker service is not running or unreachable.\n\n" +
  "To start the worker:\n" +
  "  cd worker && npm run dev\n" +
  "Or with Docker:\n" +
  "  docker compose up worker\n\n" +
  "Then retry this operation.";

export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

export class WorkerAPIClient {
  private readonly baseUrl: string;
  private readonly failureThreshold: number;
  private readonly recoveryTimeout: number;
  private readonly requestTimeout: number;
  private readonly maxRetries: number;

  state: CircuitState = CircuitState.CLOSED;
  failureCount: number = 0;
  openedAt: number | null = null;

  constructor(
    baseUrl: string,
    options?: {
      failureThreshold?: number;
      recoveryTimeout?: number;
      connectTimeout?: number;
      readTimeout?: number;
      maxRetries?: number;
    },
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.recoveryTimeout = options?.recoveryTimeout ?? 30;
    const connectTimeout = options?.connectTimeout ?? 3;
    const readTimeout = options?.readTimeout ?? 10;
    this.requestTimeout = (connectTimeout + readTimeout) * 1000;
    this.maxRetries = options?.maxRetries ?? 2;
  }

  private isOpen(): boolean {
    if (this.state === CircuitState.OPEN) {
      if (
        this.openedAt !== null &&
        (Date.now() - this.openedAt) / 1000 >= this.recoveryTimeout
      ) {
        this.state = CircuitState.HALF_OPEN;
        return false;
      }
      return true;
    }
    return false;
  }

  private recordSuccess(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
  }

  private recordFailure(): void {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.openedAt = Date.now();
    }
  }

  private async _request(
    method: string,
    path: string,
    options?: { json?: Record<string, unknown>; params?: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    if (this.isOpen()) {
      throw new WorkerUnavailableError("Circuit breaker is open");
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        let url = `${this.baseUrl}${path}`;
        if (options?.params) {
          const searchParams = new URLSearchParams();
          for (const [key, val] of Object.entries(options.params)) {
            if (val !== undefined && val !== null) {
              searchParams.set(key, String(val));
            }
          }
          const qs = searchParams.toString();
          if (qs) url += `?${qs}`;
        }

        const fetchOptions: RequestInit = {
          method: method.toUpperCase(),
          signal: AbortSignal.timeout(this.requestTimeout),
        };
        if (options?.json) {
          fetchOptions.headers = { "Content-Type": "application/json" };
          fetchOptions.body = JSON.stringify(options.json);
        }

        const response = await fetch(url, fetchOptions);

        if (response.status >= 500) {
          this.recordFailure();
          lastError = new WorkerUnavailableError(
            `Server error ${response.status}`,
          );
          if (attempt < this.maxRetries - 1) {
            await new Promise((r) =>
              setTimeout(r, 0.5 * 2 ** attempt * 1000),
            );
          }
          continue;
        }

        if (response.status === 204) {
          this.recordSuccess();
          return {};
        }

        if (response.status >= 400) {
          let msg: string;
          try {
            const detail = await response.json();
            msg =
              (detail as Record<string, Record<string, string>>).error
                ?.message ??
              (detail as Record<string, string>).message ??
              response.statusText;
          } catch {
            msg = response.statusText;
          }
          throw new WorkerAPIError(msg, response.status);
        }

        this.recordSuccess();
        return (await response.json()) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof WorkerAPIError) {
          throw error;
        }
        if (error instanceof WorkerUnavailableError) {
          lastError = error;
          continue;
        }
        // Network or timeout error
        this.recordFailure();
        lastError = new WorkerUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
        if (attempt < this.maxRetries - 1) {
          await new Promise((r) =>
            setTimeout(r, 0.5 * 2 ** attempt * 1000),
          );
        }
      }
    }

    throw lastError ?? new WorkerUnavailableError("Max retries exceeded");
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  // ── Alerts ──────────────────────────────────────────────────────────

  async getAlert(alertId: string): Promise<Record<string, unknown>> {
    return this._request("GET", `/api/alerts/${alertId}`);
  }

  async listAlerts(
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("GET", "/api/alerts/", { params });
  }

  async createAlert(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("POST", "/api/alerts/", { json: body });
  }

  async updateAlert(
    alertId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("PATCH", `/api/alerts/${alertId}`, { json: body });
  }

  async deleteAlert(alertId: string): Promise<void> {
    await this._request("DELETE", `/api/alerts/${alertId}`);
  }

  async getAlertTypes(): Promise<Record<string, unknown>> {
    return this._request("GET", "/api/alerts/types");
  }

  // ── Telegram ──────────────────────────────────────────────────────

  async listConnections(
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("GET", "/api/telegram/connections/", { params });
  }

  async createConnection(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("POST", "/api/telegram/connections/", { json: body });
  }

  async updateConnection(
    connId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("PATCH", `/api/telegram/connections/${connId}`, {
      json: body,
    });
  }

  async deleteConnection(connId: string): Promise<void> {
    await this._request("DELETE", `/api/telegram/connections/${connId}`);
  }

  async testConnection(
    connId: string,
    message: string = "",
  ): Promise<Record<string, unknown>> {
    return this._request(
      "POST",
      `/api/telegram/connections/${connId}/test`,
      { json: { message } },
    );
  }

  // ── Worker ops ──────────────────────────────────────────────────────

  async getWorkerStatus(): Promise<Record<string, unknown>> {
    return this._request("GET", "/api/worker/status");
  }

  async restartWorker(): Promise<Record<string, unknown>> {
    return this._request("POST", "/api/worker/restart");
  }

  async stopWorker(): Promise<Record<string, unknown>> {
    return this._request("POST", "/api/worker/stop");
  }

  // ── Events ──────────────────────────────────────────────────────────

  async listEvents(
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._request("GET", "/api/events/", { params });
  }
}
