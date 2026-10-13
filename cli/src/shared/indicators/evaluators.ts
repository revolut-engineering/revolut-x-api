import { Decimal } from "decimal.js";
import type { OrderBook, OrderBookLevel } from "@revolut/revolut-x-api";

import {
  computeAtr,
  computeBollinger,
  computeEma,
  computeMacd,
  computeObi,
  computePriceChangePct,
  computeRsi,
  computeSpreadPct,
  computeVolumeRatio,
} from "./core.js";

export interface MarketSnapshot {
  price?: Decimal;
  bid?: Decimal;
  ask?: Decimal;
  candles?: Array<Record<string, unknown>>;
  orderBook?: OrderBook<OrderBookLevel>;
}

export interface EvalResult {
  conditionMet: boolean;
  detail: string;
  current?: { label: string; value: string; amount?: Decimal };
  error?: string;
}

function notEnoughCandles(needed: number, available: number): EvalResult {
  return {
    conditionMet: false,
    detail: "",
    error: `needs ${needed} hourly candles, has ${available}`,
  };
}

export const CANDLE_ALERT_TYPES = new Set([
  "rsi",
  "ema_cross",
  "macd",
  "bollinger",
  "volume_spike",
  "price_change_pct",
  "atr_breakout",
]);

export const ORDERBOOK_ALERT_TYPES = new Set(["obi"]);

function parseConfig(alert: Record<string, unknown>): Record<string, unknown> {
  const raw = alert.config_json;
  if (!raw) return {};
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function plain(value: Decimal): string {
  return value.toFixed();
}

function shown(value: Decimal): string {
  return value.abs().gte(1000)
    ? value.toFixed(2)
    : value.toSignificantDigits(6).toFixed();
}

function measured(
  value: Decimal,
  threshold: Decimal,
  places: number,
): { value: Decimal; text: string } {
  const precision = Math.max(places, threshold.decimalPlaces());
  const rounded = value.toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
  return { value: rounded, text: rounded.toFixed(precision) };
}

function dec(value: unknown, defaultVal: number = 0): Decimal {
  try {
    return new Decimal(String(value));
  } catch {
    return new Decimal(defaultVal);
  }
}

function evalPrice(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (snap.price == null) {
    return { conditionMet: false, detail: "" };
  }

  const direction = String(config.direction ?? "above");
  const threshold = dec(config.threshold ?? "0");

  const met =
    direction === "above"
      ? snap.price.gte(threshold)
      : snap.price.lte(threshold);

  return {
    conditionMet: met,
    detail: `${direction === "above" ? "\u2B06\uFE0F" : "\u2B07\uFE0F"} ${direction.toUpperCase()} ${plain(threshold)}\n\uD83D\uDCB0 Current price: ${plain(snap.price)}`,
    current: { label: "Price", value: plain(snap.price), amount: snap.price },
  };
}

function evalRsi(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.candles) return { conditionMet: false, detail: "" };

  const period = Number(config.period ?? 14);
  const direction = String(config.direction ?? "above");
  const threshold = dec(config.threshold ?? "70");

  const closes = snap.candles.map((c) => dec(c.close));
  const exactRsi = computeRsi(closes, period);
  if (exactRsi == null) return notEnoughCandles(period + 1, closes.length);
  const { value: rsi, text: rsiText } = measured(exactRsi, threshold, 2);

  const met = direction === "above" ? rsi.gte(threshold) : rsi.lte(threshold);

  const emoji = rsi.gte(70)
    ? "\uD83D\uDD34"
    : rsi.lte(30)
      ? "\uD83D\uDFE2"
      : "\uD83D\uDFE1";
  return {
    conditionMet: met,
    detail: `${emoji} RSI(${period}) ${direction} ${plain(threshold)} | Current RSI: ${rsiText}`,
    current: { label: `RSI(${period})`, value: rsiText, amount: rsi },
  };
}

function evalEmaCross(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.candles) return { conditionMet: false, detail: "" };

  const fastPeriod = Number(config.fast_period ?? 9);
  const slowPeriod = Number(config.slow_period ?? 21);
  const direction = String(config.direction ?? "bullish");

  const closes = snap.candles.map((c) => dec(c.close));
  const fastEma = computeEma(closes, fastPeriod);
  const slowEma = computeEma(closes, slowPeriod);

  if (fastEma == null || slowEma == null) {
    return notEnoughCandles(Math.max(fastPeriod, slowPeriod), closes.length);
  }

  const met =
    direction === "bullish" ? fastEma.gt(slowEma) : fastEma.lt(slowEma);

  const emoji = direction === "bullish" ? "\uD83D\uDC02" : "\uD83D\uDC3B";
  return {
    conditionMet: met,
    detail:
      `${emoji} EMA(${fastPeriod}/${slowPeriod}) ${direction} crossover\n` +
      `Fast EMA: ${shown(fastEma)} | Slow EMA: ${shown(slowEma)}`,
    current: {
      label: `EMA ${fastPeriod}/${slowPeriod}`,
      value: `${shown(fastEma)} / ${shown(slowEma)}`,
    },
  };
}

function evalMacd(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.candles) return { conditionMet: false, detail: "" };

  const fast = Number(config.fast ?? 12);
  const slow = Number(config.slow ?? 26);
  const signalPeriod = Number(config.signal ?? 9);
  const direction = String(config.direction ?? "bullish");

  const closes = snap.candles.map((c) => dec(c.close));
  const result = computeMacd(closes, fast, slow, signalPeriod);
  if (result == null) {
    return notEnoughCandles(slow + signalPeriod, closes.length);
  }

  const { macd: macdLine, signal: signalLine, histogram } = result;

  const met =
    direction === "bullish" ? macdLine.gt(signalLine) : macdLine.lt(signalLine);

  const emoji = direction === "bullish" ? "\uD83D\uDC02" : "\uD83D\uDC3B";
  return {
    conditionMet: met,
    detail:
      `${emoji} MACD(${fast},${slow},${signalPeriod}) ${direction} crossover\n` +
      `MACD: ${shown(macdLine)} | Signal: ${shown(signalLine)} | Histogram: ${shown(histogram)}`,
    current: { label: "MACD", value: shown(macdLine) },
  };
}

function evalBollinger(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.candles || snap.price == null) {
    return { conditionMet: false, detail: "" };
  }

  const period = Number(config.period ?? 20);
  const stdMult = dec(config.std_mult ?? "2");
  const band = String(config.band ?? "upper");

  const closes = snap.candles.map((c) => dec(c.close));
  const result = computeBollinger(closes, period, stdMult);
  if (result == null) return notEnoughCandles(period, closes.length);

  const { upper, middle, lower } = result;

  let met: boolean;
  let detail: string;
  if (band === "upper") {
    met = snap.price.gte(upper);
    detail = `\uD83D\uDCC8 Price above upper Bollinger Band\nPrice: ${plain(snap.price)} | Upper: ${shown(upper)} | Middle: ${shown(middle)}`;
  } else {
    met = snap.price.lte(lower);
    detail = `\uD83D\uDCC9 Price below lower Bollinger Band\nPrice: ${plain(snap.price)} | Lower: ${shown(lower)} | Middle: ${shown(middle)}`;
  }

  const watched = band === "upper" ? upper : lower;
  return {
    conditionMet: met,
    detail,
    current: {
      label: `Price / BB(${period}) ${band}`,
      value: `${plain(snap.price)} / ${watched.toSignificantDigits(10).toFixed()}`,
    },
  };
}

function evalVolumeSpike(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.candles) return { conditionMet: false, detail: "" };

  const period = Number(config.period ?? 20);
  const multiplier = dec(config.multiplier ?? "2");

  const volumes = snap.candles.map((c) => dec(c.volume ?? 0));
  const exactRatio = computeVolumeRatio(volumes, period);
  if (volumes.length < period + 1) {
    return notEnoughCandles(period + 1, volumes.length);
  }
  if (exactRatio == null) {
    return {
      conditionMet: false,
      detail: `No trading volume in the last ${period} hourly candles`,
      current: { label: "Vol ratio", value: "no volume" },
    };
  }

  const { value: ratio, text: ratioText } = measured(exactRatio, multiplier, 2);
  const met = ratio.gte(multiplier);
  return {
    conditionMet: met,
    detail: `\uD83D\uDCCA Volume spike: ${ratioText}x average (${period} periods) | Threshold: ${plain(multiplier)}x`,
    current: {
      label: "Vol ratio",
      value: `${ratioText}\u00D7`,
      amount: ratio,
    },
  };
}

function evalSpread(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (snap.bid == null || snap.ask == null) {
    return { conditionMet: false, detail: "" };
  }

  const direction = String(config.direction ?? "above");
  const threshold = dec(config.threshold ?? "0.5");

  const spread = computeSpreadPct(snap.bid, snap.ask);

  const met =
    direction === "above" ? spread.gte(threshold) : spread.lte(threshold);

  return {
    conditionMet: met,
    detail: `\uD83D\uDCCF Spread ${direction} ${plain(threshold)}% | Current: ${shown(spread)}% | Bid: ${plain(snap.bid)} | Ask: ${plain(snap.ask)}`,
    current: {
      label: "Spread",
      value: `${shown(spread)}%`,
      amount: spread,
    },
  };
}

function evalObi(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.orderBook) return { conditionMet: false, detail: "" };

  const direction = String(config.direction ?? "above");
  const threshold = dec(config.threshold ?? "0.3");

  const exactObi = computeObi(snap.orderBook.bids, snap.orderBook.asks);
  if (exactObi === null) {
    return {
      conditionMet: false,
      detail: "Order book is empty",
      current: { label: "OBI", value: "empty book" },
    };
  }

  const { value: obi, text: obiText } = measured(exactObi, threshold, 4);
  const met = direction === "above" ? obi.gte(threshold) : obi.lte(threshold);

  const pressure = obi.gt(0)
    ? "\uD83D\uDFE2 Buy pressure"
    : obi.lt(0)
      ? "\uD83D\uDD34 Sell pressure"
      : "\u26AA Balanced";
  return {
    conditionMet: met,
    detail: `${pressure} | OBI: ${obiText} (${direction} ${plain(threshold)})`,
    current: { label: "OBI", value: obiText, amount: obi },
  };
}

function evalPriceChangePct(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.candles || snap.price == null) {
    return { conditionMet: false, detail: "" };
  }

  const lookback = Number(config.lookback ?? 24);
  const direction = String(config.direction ?? "above");
  const threshold = dec(config.threshold ?? "5");

  if (snap.candles.length < lookback + 1) {
    return notEnoughCandles(lookback + 1, snap.candles.length);
  }

  const previousPrice = dec(
    snap.candles[snap.candles.length - 1 - lookback].close,
  );
  const { value: changePct, text: changeText } = measured(
    computePriceChangePct(snap.price, previousPrice),
    threshold,
    2,
  );

  let met: boolean;
  let directionLabel: string;
  if (direction === "above" || direction === "rise") {
    met = changePct.gte(threshold);
    directionLabel = "rose";
  } else {
    met = changePct.lte(threshold.neg());
    directionLabel = "fell";
  }

  const emoji = changePct.gt(0) ? "\uD83D\uDE80" : "\uD83D\uDCA5";
  return {
    conditionMet: met,
    detail:
      `${emoji} Price ${directionLabel}: ${changeText}% over ${lookback} candles\n` +
      `From: ${plain(previousPrice)} \u2192 To: ${plain(snap.price)}`,
    current: {
      label: `Change ${lookback}h`,
      value: `${changePct.isNegative() ? "" : "+"}${changeText}%`,
      amount: changePct,
    },
  };
}

function evalAtrBreakout(
  _alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
): EvalResult {
  if (!snap.candles || snap.price == null) {
    return { conditionMet: false, detail: "" };
  }

  const period = Number(config.period ?? 14);
  const multiplier = dec(config.multiplier ?? "1.5");

  const highs = snap.candles.map((c) => dec(c.high));
  const lows = snap.candles.map((c) => dec(c.low));
  const closes = snap.candles.map((c) => dec(c.close));

  const atr = computeAtr(highs, lows, closes, period);
  if (atr == null) return notEnoughCandles(period + 1, closes.length);

  const prevClose = closes[closes.length - 2];
  const move = snap.price.minus(prevClose).abs();
  const breakoutThreshold = atr.times(multiplier);
  const met = move.gte(breakoutThreshold);

  const emoji = met ? "\u26A1" : "\uD83D\uDCCA";
  return {
    conditionMet: met,
    detail:
      `${emoji} ATR(${period}) breakout | Move: ${shown(move)} vs Threshold: ${shown(breakoutThreshold)}\n` +
      `ATR: ${shown(atr)} | Multiplier: ${plain(multiplier)}x | Price: ${plain(snap.price)}`,
    current: {
      label: `ATR(${period})`,
      value: `${shown(move)}/${shown(breakoutThreshold)}`,
    },
  };
}

type Evaluator = (
  alert: Record<string, unknown>,
  config: Record<string, unknown>,
  snap: MarketSnapshot,
) => EvalResult;

const EVALUATORS: Record<string, Evaluator> = {
  price: evalPrice,
  rsi: evalRsi,
  ema_cross: evalEmaCross,
  macd: evalMacd,
  bollinger: evalBollinger,
  volume_spike: evalVolumeSpike,
  spread: evalSpread,
  obi: evalObi,
  price_change_pct: evalPriceChangePct,
  atr_breakout: evalAtrBreakout,
};

export function evaluateAlert(
  alert: Record<string, unknown>,
  snapshot: MarketSnapshot,
): EvalResult {
  const alertType = String(alert.alert_type ?? "price");
  const config = parseConfig(alert);

  const evaluator = EVALUATORS[alertType];
  if (!evaluator) {
    return { conditionMet: false, detail: "" };
  }

  try {
    return evaluator(alert, config, snapshot);
  } catch (err) {
    return {
      conditionMet: false,
      detail: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
