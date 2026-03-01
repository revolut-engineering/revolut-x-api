/**
 * WorkerRunner — alert evaluation engine with setTimeout-based tick loop.
 */
import { Decimal } from "decimal.js";
import type Database from "better-sqlite3";

import { loadCredentials, type Credentials } from "../shared/auth/credentials.js";
import { buildAuthHeaders } from "../shared/auth/signer.js";
import {
  evaluateAlert,
  CANDLE_ALERT_TYPES,
  ORDERBOOK_ALERT_TYPES,
  type MarketSnapshot,
  type EvalResult,
} from "../shared/indicators/evaluators.js";
import { sendMessage, type TelegramResult } from "../shared/notify/telegram.js";
import type { WorkerStatus, WorkerSettingsResponse } from "../shared/models/worker.js";
import { createDatabase } from "../db/connection.js";
import {
  AlertRepo,
  EventRepo,
  HeartbeatRepo,
  TelegramConnectionRepo,
} from "../db/repositories.js";
import { CandleCache } from "./candle-cache.js";

const API_BASE = "https://revx.revolut.com";
const API_PREFIX = "/api/1.0";
const TICKERS_PATH = `${API_PREFIX}/tickers`;

export class WorkerRunner {
  private _tickSec: number;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private _status: "running" | "stopped" | "error" = "stopped";
  private _lastTick: string | null = null;
  private _lastError: string | null = null;
  private _startTime: number | null = null;
  private _candleCache = new CandleCache();
  private _stopping = false;
  private _dbPath?: string;

  constructor(tickSec = 10, dbPath?: string) {
    this._tickSec = tickSec;
    this._dbPath = dbPath;
  }

  async start(): Promise<void> {
    this._startTime = performance.now() / 1000;
    this._running = true;
    this._stopping = false;
    this._status = "running";

    const db = this._openDb();
    try {
      EventRepo.append(db, "worker_started", { tick_sec: this._tickSec });
      HeartbeatRepo.upsert(db, "running");
    } finally {
      db.close();
    }

    this._scheduleTick();
  }

  async stop(): Promise<void> {
    this._stopping = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._running = false;
    this._status = "stopped";

    const db = this._openDb();
    try {
      EventRepo.append(db, "worker_stopped", {});
      HeartbeatRepo.upsert(db, "stopped");
    } finally {
      db.close();
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  get isRunning(): boolean {
    return this._running;
  }

  get uptimeSeconds(): number | null {
    if (this._startTime === null) return null;
    return performance.now() / 1000 - this._startTime;
  }

  get settings(): WorkerSettingsResponse {
    return { tick_interval_sec: this._tickSec };
  }

  updateSettings(tickIntervalSec?: number | null): void {
    if (tickIntervalSec !== undefined && tickIntervalSec !== null) {
      this._tickSec = tickIntervalSec;
    }
  }

  getStatus(
    activeAlerts: number,
    enabledConnections: number,
    credentialsConfigured: boolean,
  ): WorkerStatus {
    return {
      running: this._running,
      status: this._status,
      last_tick: this._lastTick,
      last_error: this._lastError,
      active_alert_count: activeAlerts,
      enabled_connection_count: enabledConnections,
      tick_interval_sec: this._tickSec,
      uptime_seconds: this.uptimeSeconds,
      credentials_configured: credentialsConfigured,
    };
  }

  private _openDb(): Database.Database {
    return createDatabase(this._dbPath);
  }

  private _scheduleTick(delayMs = 0): void {
    if (this._stopping) return;

    this._timer = setTimeout(async () => {
      const tickStart = performance.now();
      try {
        await this._executeTick();
        this._lastTick = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        this._lastError = null;
        this._status = "running";
      } catch (err) {
        this._lastError = String(
          err instanceof Error ? err.message : err,
        ).slice(0, 500);
        this._status = "error";
      }
      const elapsed = (performance.now() - tickStart) / 1000;
      const nextDelay = Math.max(0, this._tickSec - elapsed) * 1000;

      if (!this._stopping) {
        this._scheduleTick(nextDelay);
      }
    }, delayMs);
  }

  private async _executeTick(): Promise<void> {
    const db = this._openDb();
    try {
      await this._runTick(db);
    } finally {
      db.close();
    }
  }

  private async _runTick(db: Database.Database): Promise<void> {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    HeartbeatRepo.upsert(db, "running", undefined, nowIso);

    const creds = loadCredentials();
    if (creds === null) return;

    const alerts = AlertRepo.listEnabled(db);
    if (alerts.length === 0) return;

    const tickers = await this._fetchTickers(creds);
    if (tickers === null) return;

    const [priceMap, tickerMap] = WorkerRunner.buildMaps(tickers);

    const needsCandles = new Set<string>();
    const needsOrderbook = new Set<string>();
    for (const alert of alerts) {
      const alertType = String(alert.alert_type ?? "price");
      const pair = String(alert.pair);
      if (CANDLE_ALERT_TYPES.has(alertType)) needsCandles.add(pair);
      if (ORDERBOOK_ALERT_TYPES.has(alertType)) needsOrderbook.add(pair);
    }

    for (const pair of this._candleCache.pairsNeedingRefresh(needsCandles)) {
      const candles = await this._fetchCandles(pair, creds);
      if (candles) this._candleCache.put(pair, candles);
    }

    const orderbookMap = new Map<string, Record<string, unknown>>();
    for (const pair of needsOrderbook) {
      const ob = await this._fetchOrderbook(pair, creds);
      if (ob) orderbookMap.set(pair, ob);
    }

    for (const alert of alerts) {
      try {
        const pair = String(alert.pair);
        const snapshot: MarketSnapshot = {
          price: priceMap.get(pair),
          bid: tickerMap.get(pair)?.bid,
          ask: tickerMap.get(pair)?.ask,
          candles: this._candleCache.get(pair),
          orderBook: orderbookMap.get(pair) as MarketSnapshot["orderBook"],
        };
        await this._evaluateAndNotify(alert, snapshot, db, nowIso);
      } catch {
        // Per-alert error isolation
      }
    }
  }

  static buildMaps(
    tickers: Record<string, unknown>[],
  ): [
    Map<string, Decimal>,
    Map<string, { bid?: Decimal; ask?: Decimal; price: Decimal }>,
  ] {
    const priceMap = new Map<string, Decimal>();
    const tickerMap = new Map<
      string,
      { bid?: Decimal; ask?: Decimal; price: Decimal }
    >();

    for (const t of tickers) {
      const symbol = t.symbol as string | undefined;
      const mid = (t.mid ?? t.last_price) as string | number | undefined;
      if (!symbol || mid == null) continue;

      let price: Decimal;
      try {
        price = new Decimal(String(mid));
      } catch {
        continue;
      }

      let bid: Decimal | undefined;
      let ask: Decimal | undefined;
      try {
        if (t.bid != null) bid = new Decimal(String(t.bid));
        if (t.ask != null) ask = new Decimal(String(t.ask));
      } catch {
        // ignore invalid bid/ask
      }

      const info = { bid, ask, price };
      priceMap.set(symbol, price);
      tickerMap.set(symbol, info);

      const normalized = symbol.replace("/", "-");
      if (normalized !== symbol) {
        priceMap.set(normalized, price);
        tickerMap.set(normalized, info);
      }
    }

    return [priceMap, tickerMap];
  }

  private async _evaluateAndNotify(
    alert: Record<string, unknown>,
    snapshot: MarketSnapshot,
    db: Database.Database,
    nowIso: string,
  ): Promise<void> {
    const alertId = String(alert.id);
    const pair = String(alert.pair);

    if (snapshot.price == null) return;

    const result = evaluateAlert(alert, snapshot);
    const wasTriggered = Boolean(alert.triggered);

    const updateFields: Record<string, unknown> = {
      last_checked_at: nowIso,
    };
    if (result.current) {
      updateFields.current_value_json = JSON.stringify(result.current);
    }
    AlertRepo.update(db, alertId, updateFields);

    if (!result.conditionMet) {
      if (wasTriggered) {
        AlertRepo.update(db, alertId, { triggered: 0 });
      }
      return;
    }

    if (wasTriggered) return;

    const targetConnections = WorkerRunner._resolveConnections(alert, db);
    if (targetConnections.length === 0) return;

    const alertType = String(alert.alert_type ?? "price");
    const msg = WorkerRunner.formatNotification(
      alertType,
      pair,
      snapshot.price,
      result,
    );

    for (const tc of targetConnections) {
      const sendResult = await WorkerRunner._sendWithRetries(
        String(tc.bot_token),
        String(tc.chat_id),
        msg,
      );
      const category = sendResult.success
        ? "telegram_send_ok"
        : "telegram_send_fail";
      EventRepo.append(db, category, {
        alert_id: alertId,
        pair,
        alert_type: alertType,
        price: String(snapshot.price),
        connection_id: String(tc.id),
        error: sendResult.error ?? null,
      });
    }

    AlertRepo.update(db, alertId, {
      triggered: 1,
      last_triggered_at: nowIso,
    });
    EventRepo.append(db, "alert_triggered", {
      alert_id: alertId,
      pair,
      alert_type: alertType,
      price: String(snapshot.price),
    });
  }

  static formatNotification(
    alertType: string,
    pair: string,
    price: Decimal,
    result: EvalResult,
  ): string {
    const typeLabels: Record<string, string> = {
      price: "\u{1f4c8} Price Alert",
      rsi: "\u{1f4ca} RSI Alert",
      ema_cross: "\u{1f4ca} EMA Cross Alert",
      macd: "\u{1f4ca} MACD Alert",
      bollinger: "\u{1f4ca} Bollinger Alert",
      volume_spike: "\u{1f4ca} Volume Alert",
      spread: "\u{1f4cf} Spread Alert",
      obi: "\u{1f4ca} Order Book Alert",
      price_change_pct: "\u{1f4ca} Price Change Alert",
      atr_breakout: "\u{26a1} ATR Breakout Alert",
    };
    const label = typeLabels[alertType] ?? `\u{1f4ca} ${alertType} Alert`;
    const lines = [`${label}: ${pair}`];
    if (result.detail) lines.push(result.detail);
    if (alertType !== "price") lines.push(`\u{1f4b0} Price: ${price}`);
    return lines.join("\n");
  }

  private static _resolveConnections(
    alert: Record<string, unknown>,
    db: Database.Database,
  ): Record<string, unknown>[] {
    const connectionsJson = alert.connections_json as
      | string
      | null
      | undefined;
    const allEnabled = TelegramConnectionRepo.listEnabled(db);

    if (!connectionsJson) return allEnabled;

    try {
      const targetIds = new Set(JSON.parse(connectionsJson) as string[]);
      return allEnabled.filter((c) => targetIds.has(String(c.id)));
    } catch {
      return allEnabled;
    }
  }

  static async _sendWithRetries(
    botToken: string,
    chatId: string,
    text: string,
    maxRetries = 3,
  ): Promise<TelegramResult> {
    let lastResult: TelegramResult = {
      success: false,
      error: "No attempts made",
    };
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = await sendMessage(botToken, chatId, text);
      if (result.success) return result;
      lastResult = result;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }
    return lastResult;
  }

  private async _fetchTickers(
    creds: Credentials,
  ): Promise<Record<string, unknown>[] | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = buildAuthHeaders(
        creds.apiKey,
        creds.privateKey,
        "GET",
        TICKERS_PATH,
      );
      try {
        const response = await fetch(`${API_BASE}${TICKERS_PATH}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data)) return data;
          if (data && typeof data === "object") {
            return (data as Record<string, unknown>).data
              ? ((data as Record<string, unknown>).data as Record<string, unknown>[])
              : Object.values(data as Record<string, unknown>) as Record<string, unknown>[];
          }
          return null;
        }
        if ((response.status === 401 || response.status === 409) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async _fetchCandles(
    pair: string,
    creds: Credentials,
  ): Promise<Record<string, unknown>[] | null> {
    const path = `${API_PREFIX}/candles/${pair}`;
    const query = "interval=60";
    const headers = buildAuthHeaders(
      creds.apiKey,
      creds.privateKey,
      "GET",
      path,
      query,
    );
    try {
      const response = await fetch(`${API_BASE}${path}?${query}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const raw = Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).data as unknown[]) ?? [];
      return WorkerRunner._parseCandles(raw);
    } catch {
      return null;
    }
  }

  private async _fetchOrderbook(
    pair: string,
    creds: Credentials,
  ): Promise<Record<string, unknown> | null> {
    const path = `${API_PREFIX}/public/order-book/${pair}`;
    const query = "limit=20";
    const headers = buildAuthHeaders(
      creds.apiKey,
      creds.privateKey,
      "GET",
      path,
      query,
    );
    try {
      const response = await fetch(`${API_BASE}${path}?${query}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as Record<string, unknown>;
      return (data.data as Record<string, unknown>) ?? data;
    } catch {
      return null;
    }
  }

  static _parseCandles(
    rawCandles: unknown[],
  ): Record<string, unknown>[] {
    const parsed: Record<string, unknown>[] = [];
    for (const c of rawCandles) {
      if (!c || typeof c !== "object") continue;
      const candle = c as Record<string, unknown>;
      try {
        parsed.push({
          timestamp: candle.start,
          open: new Decimal(String(candle.open ?? 0)),
          high: new Decimal(String(candle.high ?? 0)),
          low: new Decimal(String(candle.low ?? 0)),
          close: new Decimal(String(candle.close ?? 0)),
          volume: new Decimal(String(candle.volume ?? 0)),
        });
      } catch {
        continue;
      }
    }
    parsed.sort((a, b) => {
      const ta = a.timestamp as number ?? 0;
      const tb = b.timestamp as number ?? 0;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return parsed;
  }
}
