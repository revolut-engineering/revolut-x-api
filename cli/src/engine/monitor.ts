import { OutageWatch, exchangeFault } from "./outage-watch.js";
import {
  noDataMessage,
  recoveryMessage,
  refusedKeyMessage,
  refusedKeyNotice,
  savedKeyLabel,
} from "./exchange-alerts.js";
import { MONITOR_CANDLES } from "../util/monitor-options.js";
import { groupedNumber, parseDecimal } from "../util/decimal-input.js";
import { Decimal } from "decimal.js";
import {
  RevolutXClient,
  InsecureKeyPermissionsError,
} from "@revolut/revolut-x-api";
import type { Ticker, Candle } from "@revolut/revolut-x-api";
import { rethrowIfInsecureKey } from "./key-guard.js";
import chalk from "chalk";
import {
  evaluateAlert,
  CANDLE_ALERT_TYPES,
  ORDERBOOK_ALERT_TYPES,
  type MarketSnapshot,
  type EvalResult,
} from "../shared/indicators/evaluators.js";
import type { TelegramConnection } from "../db/store.js";
import { sendWithRetries, formatNotification } from "./notify.js";
import { CandleCache } from "./candle-cache.js";
import { fmtPrice } from "./grid-renderer.js";
import { resolveTickerPrice } from "../shared/price-source/index.js";

export interface MonitorSpec {
  pair: string;
  alertType: string;
  config: Record<string, unknown>;
  intervalSec: number;
}

export interface DeliveryProblem {
  error: string;
  connectionId: string;
}

export interface TickResult {
  timestamp: Date;
  price: Decimal | undefined;
  evalResult: EvalResult | null;
  triggered: boolean;
  holding?: boolean;
  alertedThisCandle?: boolean;
  notified: boolean;
  deliveryFailures?: number;
  deliveryProblem?: DeliveryProblem;
  armedWhileMet?: boolean;
  error?: string;
}

const CROSSOVER_ALERT_TYPES = new Set(["ema_cross", "macd"]);
const HOUR_MS = 60 * 60 * 1000;

export function proximity(
  alertType: string,
  current: number,
  threshold: number,
  direction: string,
): number | null {
  const falling = direction === "below" || direction === "fall";
  if (alertType === "obi") {
    const position = (current + 1) / 2;
    const target = (threshold + 1) / 2;
    if (falling) return target >= 1 ? null : (1 - position) / (1 - target);
    return target <= 0 ? null : position / target;
  }
  if (alertType === "price_change_pct") {
    if (threshold <= 0) return null;
    return Math.max(0, (falling ? -current : current) / threshold);
  }
  if (threshold <= 0) return null;
  if (current <= 0) return falling ? 1 : 0;
  return falling ? threshold / current : current / threshold;
}

export const TYPE_LABELS: Record<string, string> = {
  price: "Price Threshold",
  rsi: "RSI",
  ema_cross: "EMA Crossover",
  macd: "MACD",
  bollinger: "Bollinger Bands",
  volume_spike: "Volume Spike",
  spread: "Bid-Ask Spread",
  obi: "Order Book Imbalance",
  price_change_pct: "Price Change %",
  atr_breakout: "ATR Breakout",
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  USDT: "$",
  USDC: "$",
  EUR: "\u20AC",
  GBP: "\u00A3",
};

export class ForegroundMonitor {
  private _spec: MonitorSpec;
  private _connections: TelegramConnection[];
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _candleCache = new CandleCache();
  private _client: RevolutXClient | null = null;
  private _keyLabel: string | null = null;
  private _triggered = false;
  private _checkedOnce = false;
  private _armedHold = false;
  private _alertedCandle: number | undefined = undefined;
  private readonly _pendingEvents: string[] = [];
  private readonly _outage = new OutageWatch();
  private _prevPrice: Decimal | null = null;
  private _tickCount = 0;
  private _currSymbol: string;

  constructor(spec: MonitorSpec, connections: TelegramConnection[] = []) {
    this._spec = spec;
    this._connections = connections;
    const quote = spec.pair.split("-")[1] ?? "";
    this._currSymbol = CURRENCY_SYMBOLS[quote] ?? "";
  }

  stop(): void {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async run(): Promise<void> {
    this._running = true;
    this._client = new RevolutXClient({
      generatedBy: "CLI",
      enforceKeyPermissions: true,
    });
    this._keyLabel = savedKeyLabel();
    this._client.assertAuthenticated();
    await this._loop();
  }

  private async _loop(): Promise<void> {
    while (this._running) {
      const tickStart = performance.now();

      try {
        const result = await this._runTick();
        this._printTick(result);
      } catch (err) {
        if (err instanceof InsecureKeyPermissionsError) {
          console.log(
            chalk.red(
              `\n  Halting monitor: credential file permissions are unsafe.\n  ${err.message}`,
            ),
          );
          this.stop();
          throw err;
        }
        const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
        const message = err instanceof Error ? err.message : String(err);
        console.log(
          `  ${chalk.dim(time)}  ${chalk.red("\u2717")} ${chalk.yellow(message)}`,
        );
      }

      const elapsed = (performance.now() - tickStart) / 1000;
      const delay = Math.max(0, this._spec.intervalSec - elapsed) * 1000;
      if (!this._running) break;
      await new Promise<void>((resolve) => {
        this._timer = setTimeout(() => {
          this._timer = null;
          resolve();
        }, delay);
      });
    }
  }

  private async _runTick(): Promise<TickResult> {
    const client = this._client!;
    const { pair, alertType, config } = this._spec;
    const result: TickResult = {
      timestamp: new Date(),
      price: undefined,
      evalResult: null,
      triggered: false,
      notified: false,
    };

    let tickerResponse;
    try {
      tickerResponse = await client.getTickers({ symbols: [pair] });
    } catch (err) {
      rethrowIfInsecureKey(err);
      result.error = `Failed to fetch ticker: ${err instanceof Error ? err.message : String(err)}`;
      await this._noteExchangeFailure(result.error, err);
      return result;
    }

    const [priceMap, tickerMap] = ForegroundMonitor.buildMaps(
      tickerResponse.data,
    );
    result.price = priceMap.get(pair);

    if (result.price == null) {
      result.error = `No price data for ${pair}`;
      await this._noteExchangeFailure(result.error);
      return result;
    }

    const snapshot: MarketSnapshot = {
      price: priceMap.get(pair),
      bid: tickerMap.get(pair)?.bid,
      ask: tickerMap.get(pair)?.ask,
    };

    if (CANDLE_ALERT_TYPES.has(alertType)) {
      if (this._candleCache.needsRefresh(pair)) {
        try {
          const hourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
          const resp = await client.getCandles(pair, {
            interval: 60,
            startDate: hourStart - (MONITOR_CANDLES + 1) * HOUR_MS,
          });
          const candles = ForegroundMonitor.parseCandles(resp.data);
          this._candleCache.put(pair, candles);
        } catch (err) {
          rethrowIfInsecureKey(err);
          result.error = `Failed to fetch candles: ${err instanceof Error ? err.message : String(err)}`;
          await this._noteExchangeFailure(result.error, err);
          return result;
        }
      }
      snapshot.candles = this._candleCache.get(pair);
    }

    if (ORDERBOOK_ALERT_TYPES.has(alertType)) {
      try {
        const resp = await client.getOrderBook(pair, { limit: 20 });
        snapshot.orderBook = resp.data;
      } catch (err) {
        rethrowIfInsecureKey(err);
        result.error = `Failed to fetch order book: ${err instanceof Error ? err.message : String(err)}`;
        await this._noteExchangeFailure(result.error, err);
        return result;
      }
    }
    await this._noteExchangeBack();

    const alertRecord = {
      alert_type: alertType,
      config_json: JSON.stringify(config),
    };
    const evalResult = evaluateAlert(alertRecord, snapshot);
    if (evalResult.error) {
      result.error = `Could not evaluate ${alertType}: ${evalResult.error}`;
      return result;
    }
    result.evalResult = evalResult;

    const firstCheck = !this._checkedOnce;
    this._checkedOnce = true;
    if (firstCheck && CROSSOVER_ALERT_TYPES.has(alertType)) {
      this._armedHold = evalResult.conditionMet;
      result.armedWhileMet = evalResult.conditionMet;
      return result;
    }
    if (this._armedHold) {
      if (evalResult.conditionMet) return result;
      this._armedHold = false;
    }

    if (!evalResult.conditionMet) {
      if (this._triggered) {
        this._triggered = false;
      }
      return result;
    }

    if (this._triggered) {
      result.holding = true;
      return result;
    }

    if (CROSSOVER_ALERT_TYPES.has(alertType)) {
      const candle = snapshot.candles?.at(-1)?.timestamp as number | undefined;
      if (candle !== undefined && candle === this._alertedCandle) {
        this._triggered = true;
        result.holding = true;
        result.alertedThisCandle = true;
        return result;
      }
      this._alertedCandle = candle;
    }

    this._triggered = true;
    result.triggered = true;

    if (this._connections.length > 0) {
      const sent = await this._send(
        formatNotification(alertType, pair, result.price, evalResult),
      );
      result.notified = sent.delivered > 0;
      result.deliveryFailures = this._connections.length - sent.delivered;
      result.deliveryProblem = sent.problem ?? undefined;
    }

    return result;
  }

  private async _send(
    message: string,
  ): Promise<{ delivered: number; problem: DeliveryProblem | null }> {
    let delivered = 0;
    let problem: DeliveryProblem | null = null;
    for (const tc of this._connections) {
      const sent = await sendWithRetries(tc.bot_token, tc.chat_id, message);
      if (sent.success) {
        delivered++;
      } else {
        problem ??= {
          error: (sent.error ?? "not delivered").replace(/\.+$/, ""),
          connectionId: tc.id,
        };
      }
    }
    return { delivered, problem };
  }

  private _lost(delivered: number): boolean {
    return this._connections.length > 0 && delivered === 0;
  }

  private async _noteExchangeFailure(
    error: string,
    cause?: unknown,
  ): Promise<void> {
    const alert = this._outage.failed(exchangeFault(cause));
    if (!alert) return;
    const refused = alert.fault === "refused";
    if (!alert.retry) {
      this._printEvent(
        chalk.yellow(
          refused
            ? `${refusedKeyNotice(cause, "monitor")} Still trying.`
            : `No data from Revolut X for ${alert.minutes} minutes. Still trying.`,
        ),
      );
    }
    const sent = await this._send(
      refused
        ? refusedKeyMessage(this._title(), cause, {
            user: "monitor",
            keyLabel: this._keyLabel,
          })
        : noDataMessage(this._title(), alert.minutes, error),
    );
    if (this._lost(sent.delivered)) this._outage.undelivered(alert);
  }

  private async _noteExchangeBack(): Promise<void> {
    const alert = this._outage.recovered();
    if (!alert) return;
    if (!alert.retry) {
      this._printEvent(
        chalk.green(
          alert.fault === "refused"
            ? "Revolut X accepts the API key again."
            : "Data from Revolut X is back.",
        ),
      );
    }
    const sent = await this._send(recoveryMessage(this._title(), alert));
    if (this._lost(sent.delivered)) this._outage.undelivered(alert);
  }

  private _title(): string {
    const type = TYPE_LABELS[this._spec.alertType] ?? this._spec.alertType;
    return `Monitor ${type} ${this._spec.pair}`;
  }

  private _printEvent(text: string): void {
    this._pendingEvents.push(text);
  }

  private _flushEvents(time: string): void {
    for (const event of this._pendingEvents.splice(0)) {
      console.log(`  ${chalk.dim(time)}  ${event}`);
    }
  }

  private _printTick(result: TickResult): void {
    const time = result.timestamp.toLocaleTimeString("en-GB", {
      hour12: false,
    });

    if (result.error) {
      console.log(
        `  ${chalk.dim(time)}  ${chalk.red("\u2717")} ${chalk.yellow(result.error)}`,
      );
      this._flushEvents(time);
      this._tickCount++;
      return;
    }

    this._flushEvents(time);
    const priceStr = result.price ? this._formatPrice(result.price) : "";

    let deltaStr = "";
    if (this._tickCount > 0 && this._prevPrice && result.price) {
      deltaStr = this._formatDelta(result.price, this._prevPrice);
    }

    const indicatorStr = result.evalResult?.current
      ? `${chalk.dim(result.evalResult.current.label + ":")} ${chalk.white(result.evalResult.current.value)}`
      : "";

    const barStr = this._proximityBar(result.evalResult);

    if (result.triggered && result.notified) {
      const total = this._connections.length;
      const delivered = total - (result.deliveryFailures ?? 0);
      const connLabel =
        delivered === total
          ? total === 1
            ? "1 connection"
            : `${total} connections`
          : `${delivered} of ${total} connections`;
      const line1 = `  ${chalk.dim(time)}  ${chalk.bold.cyan(this._spec.pair)}  ${chalk.white.bold(priceStr)}  ${deltaStr}`;
      const line2 = "";
      const line3Left = `  ${chalk.red.bold("\u25C6 TRIGGERED")}`;
      const line3Right = `${chalk.green("\u2713 Notified")} ${chalk.dim(`(${connLabel})`)}`;
      const cleanDetail = result.evalResult?.detail
        ? result.evalResult.detail
            .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
            .replace(/[\u2B06\u2B07]\uFE0F?/g, "")
            .trim()
        : "";
      const contentLines = [line1, line2, line3Left + "  " + line3Right];
      if (cleanDetail) {
        for (const dl of cleanDetail.split("\n")) {
          const trimmed = dl.trim();
          if (trimmed) contentLines.push(`  ${chalk.dim(trimmed)}`);
        }
      }
      console.log(this._box(contentLines, "single"));
    } else if (result.triggered) {
      const line1 = `  ${chalk.dim(time)}  ${chalk.bold.cyan(this._spec.pair)}  ${chalk.white.bold(priceStr)}  ${deltaStr}`;
      const line2 = "";
      const line3 =
        `  ${chalk.red.bold("\u25C6 TRIGGERED")}` +
        (result.deliveryFailures
          ? `  ${chalk.red("\u2717 Notification failed")}`
          : "");
      const cleanDetail = result.evalResult?.detail
        ? result.evalResult.detail
            .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
            .replace(/[\u2B06\u2B07]\uFE0F?/g, "")
            .trim()
        : "";
      const contentLines = [line1, line2, line3];
      if (cleanDetail) {
        for (const dl of cleanDetail.split("\n")) {
          const trimmed = dl.trim();
          if (trimmed) contentLines.push(`  ${chalk.dim(trimmed)}`);
        }
      }
      console.log(this._box(contentLines, "single"));
    } else {
      const parts = [`  ${chalk.dim(time)}  ${priceStr}  ${deltaStr}`];
      if (indicatorStr) parts.push(`${chalk.dim("\u2502")}  ${indicatorStr}`);
      if (barStr) parts.push(barStr);
      parts.push(
        result.alertedThisCandle
          ? chalk.red("\u25C6 alerted this hour")
          : result.holding
            ? chalk.red("\u25C6 still met")
            : chalk.dim("\u25CB"),
      );
      console.log(parts.join("  "));
      if (result.armedWhileMet) {
        console.log(
          chalk.dim(
            "  The trend is already in place. Waiting for a fresh crossover.",
          ),
        );
      }
    }

    this._printDeliveryProblem(result.deliveryProblem);
    if (result.price) this._prevPrice = result.price;
    this._tickCount++;
  }

  private _printDeliveryProblem(problem: DeliveryProblem | undefined): void {
    if (!problem) return;
    console.log(`  ${chalk.red(`\u2717 Telegram: ${problem.error}`)}`);
    console.log(
      chalk.dim(
        `    Test it with: revx connector telegram test ${problem.connectionId}`,
      ),
    );
  }

  private _formatPrice(price: Decimal): string {
    return fmtPrice(price, this._currSymbol);
  }

  private _formatDelta(current: Decimal, previous: Decimal): string {
    if (previous.isZero()) return "";
    const pct = current.minus(previous).div(previous).times(100);
    const sign = pct.isNegative() ? "" : "+";
    const str = `${sign}${pct.toFixed(2)}%`;
    if (pct.gt(0)) return chalk.green(`\u25B2 ${str}`);
    if (pct.lt(0)) return chalk.red(`\u25BC ${str}`);
    return chalk.dim(`= ${str}`);
  }

  private _proximityBar(evalResult: EvalResult | null): string {
    const amount = evalResult?.current?.amount;
    if (!evalResult || !amount) return "";

    const cfg = this._spec.config;
    const thresholdRaw = cfg.threshold ?? cfg.multiplier;
    if (thresholdRaw == null) return "";
    const threshold = parseDecimal(String(thresholdRaw));
    if (!threshold) return "";

    const ratio = proximity(
      this._spec.alertType,
      amount.toNumber(),
      threshold.toNumber(),
      String(cfg.direction ?? "above"),
    );
    if (ratio === null) return "";
    const filled = Math.min(20, Math.max(0, Math.round(ratio * 20)));
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(20 - filled);

    return evalResult.conditionMet ? chalk.green(bar) : chalk.dim(bar);
  }

  private _stripAnsi(str: string): number {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*m/g, "").length;
  }

  private _box(lines: string[], style: "double" | "single"): string {
    const chars =
      style === "double"
        ? {
            tl: "\u2554",
            tr: "\u2557",
            bl: "\u255A",
            br: "\u255D",
            h: "\u2550",
            v: "\u2551",
          }
        : {
            tl: "\u250C",
            tr: "\u2510",
            bl: "\u2514",
            br: "\u2518",
            h: "\u2500",
            v: "\u2502",
          };

    let maxWidth = 0;
    for (const line of lines) {
      const w = this._stripAnsi(line);
      if (w > maxWidth) maxWidth = w;
    }
    maxWidth += 4;

    const top = `  ${chars.tl}${chars.h.repeat(maxWidth)}${chars.tr}`;
    const bot = `  ${chars.bl}${chars.h.repeat(maxWidth)}${chars.br}`;
    const padded = lines.map((line) => {
      const pad = maxWidth - this._stripAnsi(line) - 2;
      return `  ${chars.v}${line}${" ".repeat(Math.max(0, pad))}  ${chars.v}`;
    });

    return [top, ...padded, bot].join("\n");
  }

  static formatConfigHuman(
    alertType: string,
    config: Record<string, unknown>,
    currSymbol: string,
  ): string {
    const fmt = (n: unknown) => {
      const number = parseDecimal(String(n));
      return number ? `${currSymbol}${groupedNumber(number)}` : String(n);
    };

    switch (alertType) {
      case "price": {
        const dir = String(config.direction ?? "above");
        return `${dir.charAt(0).toUpperCase() + dir.slice(1)} ${fmt(config.threshold ?? 0)}`;
      }
      case "rsi": {
        const dir = String(config.direction ?? "above");
        const period = config.period ?? 14;
        return `RSI ${dir} ${config.threshold ?? 70} (period ${period})`;
      }
      case "ema_cross": {
        const dir = String(config.direction ?? "bullish");
        const fast = config.fast_period ?? 9;
        const slow = config.slow_period ?? 21;
        return `${dir.charAt(0).toUpperCase() + dir.slice(1)} crossover (EMA ${fast}/${slow})`;
      }
      case "macd": {
        const dir = String(config.direction ?? "bullish");
        return `${dir.charAt(0).toUpperCase() + dir.slice(1)} crossover (${config.fast ?? 12}/${config.slow ?? 26}/${config.signal ?? 9})`;
      }
      case "bollinger": {
        const band = String(config.band ?? "upper");
        return `${band.charAt(0).toUpperCase() + band.slice(1)} band (period ${config.period ?? 20})`;
      }
      case "volume_spike":
        return `${config.multiplier ?? 2.0}x average (period ${config.period ?? 20})`;
      case "spread": {
        const dir = String(config.direction ?? "above");
        return `Spread ${dir} ${config.threshold ?? 0.5}%`;
      }
      case "obi": {
        const dir = String(config.direction ?? "above");
        return `OBI ${dir} ${config.threshold ?? 0.3}`;
      }
      case "price_change_pct": {
        const dir = String(config.direction ?? "rise");
        return `${dir.charAt(0).toUpperCase() + dir.slice(1)} \u2265 ${config.threshold ?? 5}% (${config.lookback ?? 24}h)`;
      }
      case "atr_breakout":
        return `${config.multiplier ?? 1.5}x ATR (period ${config.period ?? 14})`;
      default:
        return JSON.stringify(config);
    }
  }

  static printBanner(spec: MonitorSpec, connectionCount = 0): void {
    const quote = spec.pair.split("-")[1] ?? "";
    const currSymbol = CURRENCY_SYMBOLS[quote] ?? "";
    const typeLabel = TYPE_LABELS[spec.alertType] ?? spec.alertType;
    const condition = ForegroundMonitor.formatConfigHuman(
      spec.alertType,
      spec.config,
      currSymbol,
    );
    const connStr =
      connectionCount === 0
        ? chalk.yellow("None")
        : `${connectionCount} connection${connectionCount !== 1 ? "s" : ""}`;

    const w = 48;
    const h = "\u2550";
    const titleVisual = "REVX MONITOR  \u25CF  LIVE";
    const titlePad = Math.max(0, w - titleVisual.length);
    const titleLeft = Math.floor(titlePad / 2);
    const titleRight = titlePad - titleLeft;

    const pad = (label: string, value: string) => {
      const content = `   ${chalk.dim(label.padEnd(11))}${value}`;
      const visual = `   ${label.padEnd(11)}${value}`;
      const right = Math.max(0, w - visual.length);
      return content + " ".repeat(right);
    };

    const emptyLine = " ".repeat(w);

    const lines = [
      `\u2554${h.repeat(w)}\u2557`,
      `\u2551${" ".repeat(titleLeft)}${chalk.bold.white("REVX MONITOR")}  ${chalk.green("\u25CF")}  ${chalk.green("LIVE")}${" ".repeat(titleRight)}\u2551`,
      `\u2560${h.repeat(w)}\u2563`,
      `\u2551${emptyLine}\u2551`,
      `\u2551   ${chalk.bold.cyan(spec.pair)}${" ".repeat(Math.max(0, w - 3 - spec.pair.length))}\u2551`,
      `\u2551${emptyLine}\u2551`,
      `\u2551${pad("Type", typeLabel)}\u2551`,
      `\u2551${pad("Condition", condition)}\u2551`,
      `\u2551${pad("Interval", `Every ${spec.intervalSec}s`)}\u2551`,
      `\u2551${pad("Telegram", connStr)}\u2551`,
      `\u2551${emptyLine}\u2551`,
      `\u255A${h.repeat(w)}\u255D`,
    ];

    console.log(lines.join("\n"));
    console.log(chalk.dim("  Press Ctrl+C to stop\n"));
  }

  static buildMaps(
    tickers: Ticker[],
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
      if (!t.symbol) continue;
      const price = resolveTickerPrice(t);
      if (price == null) continue;

      let bid: Decimal | undefined;
      let ask: Decimal | undefined;
      try {
        if (t.bid != null) bid = new Decimal(String(t.bid));
        if (t.ask != null) ask = new Decimal(String(t.ask));
      } catch {}

      const info = { bid, ask, price };
      priceMap.set(t.symbol, price);
      tickerMap.set(t.symbol, info);

      const normalized = t.symbol.replace("/", "-");
      if (normalized !== t.symbol) {
        priceMap.set(normalized, price);
        tickerMap.set(normalized, info);
      }
    }

    return [priceMap, tickerMap];
  }

  static parseCandles(candles: Candle[]): Record<string, unknown>[] {
    const parsed: Record<string, unknown>[] = [];
    for (const c of candles) {
      try {
        parsed.push({
          timestamp: c.start,
          open: new Decimal(String(c.open)),
          high: new Decimal(String(c.high)),
          low: new Decimal(String(c.low)),
          close: new Decimal(String(c.close)),
          volume: new Decimal(String(c.volume)),
        });
      } catch {
        continue;
      }
    }
    parsed.sort((a, b) => {
      const ta = (a.timestamp as number) ?? 0;
      const tb = (b.timestamp as number) ?? 0;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return parsed;
  }
}
