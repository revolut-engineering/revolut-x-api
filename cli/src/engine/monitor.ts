import { Decimal } from "decimal.js";
import { RevolutXClient } from "revolutx-api";
import type { Ticker, Candle } from "revolutx-api";
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

export interface MonitorSpec {
  pair: string;
  alertType: string;
  config: Record<string, unknown>;
  intervalSec: number;
}

export interface TickResult {
  timestamp: Date;
  price: Decimal | undefined;
  evalResult: EvalResult | null;
  triggered: boolean;
  notified: boolean;
  error?: string;
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

const BAR_ALERT_TYPES = new Set([
  "price",
  "rsi",
  "spread",
  "obi",
  "price_change_pct",
  "volume_spike",
]);

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
  private _triggered = false;
  private _prevPrice: Decimal | null = null;
  private _tickCount = 0;
  private _currSymbol: string;

  constructor(spec: MonitorSpec, connections: TelegramConnection[]) {
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
    this._client = new RevolutXClient();
    if (!this._client.isAuthenticated) {
      throw new Error(
        "API credentials not configured. Run 'revx configure' first.",
      );
    }
    await this._loop();
  }

  private async _loop(): Promise<void> {
    while (this._running) {
      const tickStart = performance.now();

      try {
        const result = await this._runTick();
        this._printTick(result);
      } catch (err) {
        const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
        console.log(
          `  ${chalk.dim(time)}  ${chalk.red("\u2717")} ${chalk.yellow(err instanceof Error ? err.message : String(err))}`,
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
      result.error = `Failed to fetch ticker: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    const [priceMap, tickerMap] = ForegroundMonitor.buildMaps(
      tickerResponse.data,
    );
    result.price = priceMap.get(pair);

    if (result.price == null) {
      result.error = `No price data for ${pair}`;
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
          const resp = await client.getCandles(pair, { interval: 60 });
          const candles = ForegroundMonitor.parseCandles(resp.data);
          this._candleCache.put(pair, candles);
        } catch (err) {
          result.error = `Failed to fetch candles: ${err instanceof Error ? err.message : String(err)}`;
          return result;
        }
      }
      snapshot.candles = this._candleCache.get(pair);
    }

    if (ORDERBOOK_ALERT_TYPES.has(alertType)) {
      try {
        const resp = await client.getOrderBook(pair, { limit: 20 });
        snapshot.orderBook = {
          bids: resp.data.bids as unknown as Record<string, unknown>[],
          asks: resp.data.asks as unknown as Record<string, unknown>[],
        };
      } catch (err) {
        result.error = `Failed to fetch order book: ${err instanceof Error ? err.message : String(err)}`;
        return result;
      }
    }

    const alertRecord = {
      alert_type: alertType,
      config_json: JSON.stringify(config),
    };
    const evalResult = evaluateAlert(alertRecord, snapshot);
    result.evalResult = evalResult;

    if (!evalResult.conditionMet) {
      if (this._triggered) {
        this._triggered = false;
      }
      return result;
    }

    if (this._triggered) {
      result.triggered = true;
      return result;
    }

    this._triggered = true;
    result.triggered = true;

    if (this._connections.length > 0) {
      const msg = formatNotification(alertType, pair, result.price, evalResult);
      for (const tc of this._connections) {
        await sendWithRetries(tc.bot_token, tc.chat_id, msg);
      }
      result.notified = true;
    }

    return result;
  }

  private _printTick(result: TickResult): void {
    const time = result.timestamp.toLocaleTimeString("en-GB", {
      hour12: false,
    });

    if (result.error) {
      console.log(
        `  ${chalk.dim(time)}  ${chalk.red("\u2717")} ${chalk.yellow(result.error)}`,
      );
      this._tickCount++;
      return;
    }

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
      const connLabel =
        this._connections.length === 1
          ? "1 connection"
          : `${this._connections.length} connections`;
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
      const parts = [`  ${chalk.dim(time)}  ${priceStr}  ${deltaStr}`];
      if (indicatorStr) parts.push(`${chalk.dim("\u2502")}  ${indicatorStr}`);
      if (barStr) parts.push(barStr);
      parts.push(chalk.red("\u25C6"));
      console.log(parts.join("  "));
    } else {
      const parts = [`  ${chalk.dim(time)}  ${priceStr}  ${deltaStr}`];
      if (indicatorStr) parts.push(`${chalk.dim("\u2502")}  ${indicatorStr}`);
      if (barStr) parts.push(barStr);
      parts.push(chalk.dim("\u25CB"));
      console.log(parts.join("  "));
    }

    if (result.price) this._prevPrice = result.price;
    this._tickCount++;
  }

  private _formatPrice(price: Decimal): string {
    const num = price.toNumber();
    const formatted =
      num < 1
        ? num.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 8,
          })
        : num.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
    return `${this._currSymbol}${formatted}`;
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
    if (!evalResult?.current) return "";
    if (!BAR_ALERT_TYPES.has(this._spec.alertType)) return "";

    const rawValue = evalResult.current.value.replace(/[^0-9.\u002D]/g, "");
    const currentNum = parseFloat(rawValue);
    if (isNaN(currentNum)) return "";

    const cfg = this._spec.config;
    const thresholdRaw = cfg.threshold ?? cfg.multiplier;
    if (thresholdRaw == null) return "";
    const thresholdNum = parseFloat(String(thresholdRaw));
    if (isNaN(thresholdNum) || thresholdNum === 0) return "";

    const ratio = Math.abs(currentNum) / Math.abs(thresholdNum);
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
      const num = Number(n);
      if (isNaN(num)) return String(n);
      return num < 1
        ? `${currSymbol}${num}`
        : `${currSymbol}${num.toLocaleString("en-US")}`;
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

  static printBanner(spec: MonitorSpec, connectionCount: number): void {
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
      const mid = t.mid ?? t.last_price;
      if (!t.symbol || mid == null) continue;

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
