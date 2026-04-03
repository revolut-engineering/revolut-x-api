import { Decimal } from "decimal.js";

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
  orderBook?: {
    bids: Array<Record<string, unknown>>;
    asks: Array<Record<string, unknown>>;
  };
}

interface EvalResult {
  conditionMet: boolean;
  detail: string;
  current?: { label: string; value: string };
}

function parseConfig(alert: Record<string, unknown>): Record<string, unknown> {
  const raw = alert.config_json;
  if (!raw) return {};
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
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
    detail: `${direction === "above" ? "\u2B06\uFE0F" : "\u2B07\uFE0F"} ${direction.toUpperCase()} ${threshold}\n\uD83D\uDCB0 Current price: ${snap.price}`,
    current: { label: "Price", value: String(snap.price) },
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
  const rsi = computeRsi(closes, period);
  if (rsi == null) return { conditionMet: false, detail: "" };

  const met = direction === "above" ? rsi.gte(threshold) : rsi.lte(threshold);

  const emoji = rsi.gte(70)
    ? "\uD83D\uDD34"
    : rsi.lte(30)
      ? "\uD83D\uDFE2"
      : "\uD83D\uDFE1";
  return {
    conditionMet: met,
    detail: `${emoji} RSI(${period}) ${direction} ${threshold} | Current RSI: ${rsi}`,
    current: { label: `RSI(${period})`, value: rsi.toFixed(2) },
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
    return { conditionMet: false, detail: "" };
  }

  const met =
    direction === "bullish" ? fastEma.gt(slowEma) : fastEma.lt(slowEma);

  const emoji = direction === "bullish" ? "\uD83D\uDC02" : "\uD83D\uDC3B";
  return {
    conditionMet: met,
    detail:
      `${emoji} EMA(${fastPeriod}/${slowPeriod}) ${direction} crossover\n` +
      `Fast EMA: ${fastEma.toFixed(2)} | Slow EMA: ${slowEma.toFixed(2)}`,
    current: {
      label: `EMA ${fastPeriod}/${slowPeriod}`,
      value: `${fastEma.toFixed(2)} / ${slowEma.toFixed(2)}`,
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
  if (result == null) return { conditionMet: false, detail: "" };

  const { macd: macdLine, signal: signalLine, histogram } = result;

  const met =
    direction === "bullish" ? macdLine.gt(signalLine) : macdLine.lt(signalLine);

  const emoji = direction === "bullish" ? "\uD83D\uDC02" : "\uD83D\uDC3B";
  return {
    conditionMet: met,
    detail:
      `${emoji} MACD(${fast},${slow},${signalPeriod}) ${direction} crossover\n` +
      `MACD: ${macdLine} | Signal: ${signalLine} | Histogram: ${histogram}`,
    current: { label: "MACD", value: macdLine.toFixed(4) },
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
  if (result == null) return { conditionMet: false, detail: "" };

  const { upper, middle, lower } = result;

  let met: boolean;
  let detail: string;
  if (band === "upper") {
    met = snap.price.gte(upper);
    detail = `\uD83D\uDCC8 Price above upper Bollinger Band\nPrice: ${snap.price} | Upper: ${upper} | Middle: ${middle}`;
  } else {
    met = snap.price.lte(lower);
    detail = `\uD83D\uDCC9 Price below lower Bollinger Band\nPrice: ${snap.price} | Lower: ${lower} | Middle: ${middle}`;
  }

  return {
    conditionMet: met,
    detail,
    current: { label: `BB(${period})`, value: String(snap.price) },
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
  const ratio = computeVolumeRatio(volumes, period);
  if (ratio == null) return { conditionMet: false, detail: "" };

  const met = ratio.gte(multiplier);
  return {
    conditionMet: met,
    detail: `\uD83D\uDCCA Volume spike: ${ratio}x average (${period} periods) | Threshold: ${multiplier}x`,
    current: { label: "Vol ratio", value: `${ratio.toFixed(2)}\u00D7` },
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
    detail: `\uD83D\uDCCF Spread ${direction} ${threshold}% | Current: ${spread}% | Bid: ${snap.bid} | Ask: ${snap.ask}`,
    current: { label: "Spread", value: `${spread.toFixed(4)}%` },
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

  const bids = snap.orderBook.bids ?? [];
  const asks = snap.orderBook.asks ?? [];
  const obi = computeObi(bids, asks);

  const met = direction === "above" ? obi.gte(threshold) : obi.lte(threshold);

  const buyPressure = obi.gt(0)
    ? "\uD83D\uDFE2 Buy pressure"
    : "\uD83D\uDD34 Sell pressure";
  return {
    conditionMet: met,
    detail: `${buyPressure} | OBI: ${obi} (${direction} ${threshold})`,
    current: { label: "OBI", value: obi.toFixed(4) },
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

  if (snap.candles.length < lookback) {
    return { conditionMet: false, detail: "" };
  }

  const previousPrice = dec(snap.candles[snap.candles.length - lookback].close);
  const changePct = computePriceChangePct(snap.price, previousPrice);

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
      `${emoji} Price ${directionLabel}: ${changePct}% over ${lookback} candles\n` +
      `From: ${previousPrice} \u2192 To: ${snap.price}`,
    current: {
      label: `Change ${lookback}h`,
      value: `${changePct.isNegative() ? "" : "+"}${changePct.toFixed(2)}%`,
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
  if (atr == null) return { conditionMet: false, detail: "" };

  const prevClose =
    closes.length >= 2 ? closes[closes.length - 2] : closes[closes.length - 1];
  const move = snap.price.minus(prevClose).abs();
  const breakoutThreshold = atr.times(multiplier);
  const met = move.gte(breakoutThreshold);

  const emoji = met ? "\u26A1" : "\uD83D\uDCCA";
  return {
    conditionMet: met,
    detail:
      `${emoji} ATR(${period}) breakout | Move: ${move.toFixed(2)} vs Threshold: ${breakoutThreshold.toFixed(2)}\n` +
      `ATR: ${atr} | Multiplier: ${multiplier}x | Price: ${snap.price}`,
    current: {
      label: `ATR(${period})`,
      value: `${move.toFixed(2)}/${breakoutThreshold.toFixed(2)}`,
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
  } catch {
    return { conditionMet: false, detail: "" };
  }
}
