import { Decimal } from "decimal.js";

export function decimalSqrt(value: Decimal, precision: number = 20): Decimal {
  if (value.isNegative()) {
    throw new Error("Cannot compute sqrt of negative number");
  }
  if (value.isZero()) {
    return new Decimal(0);
  }

  let x = value;
  for (let i = 0; i < precision; i++) {
    x = x.plus(value.div(x)).div(2);
  }
  return x;
}

export function computeSma(values: Decimal[], period: number): Decimal | null {
  if (values.length < period || period < 1) {
    return null;
  }
  const window = values.slice(-period);
  let sum = new Decimal(0);
  for (const v of window) {
    sum = sum.plus(v);
  }
  return sum.div(period);
}

export function computeEma(values: Decimal[], period: number): Decimal | null {
  if (values.length < period || period < 1) {
    return null;
  }

  const multiplier = new Decimal(2).div(new Decimal(period).plus(1));
  let ema = new Decimal(0);
  for (let i = 0; i < period; i++) {
    ema = ema.plus(values[i]);
  }
  ema = ema.div(period);

  for (let i = period; i < values.length; i++) {
    ema = values[i].minus(ema).times(multiplier).plus(ema);
  }
  return ema;
}

export function computeRsi(
  closes: Decimal[],
  period: number = 14,
): Decimal | null {
  if (closes.length < period + 1 || period < 1) {
    return null;
  }

  const gains: Decimal[] = [];
  const losses: Decimal[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i].minus(closes[i - 1]);
    if (change.isPositive()) {
      gains.push(change);
      losses.push(new Decimal(0));
    } else {
      gains.push(new Decimal(0));
      losses.push(change.abs());
    }
  }

  let avgGain = new Decimal(0);
  let avgLoss = new Decimal(0);
  for (let i = 0; i < period; i++) {
    avgGain = avgGain.plus(gains[i]);
    avgLoss = avgLoss.plus(losses[i]);
  }
  avgGain = avgGain.div(period);
  avgLoss = avgLoss.div(period);

  for (let i = period; i < gains.length; i++) {
    avgGain = avgGain
      .times(period - 1)
      .plus(gains[i])
      .div(period);
    avgLoss = avgLoss
      .times(period - 1)
      .plus(losses[i])
      .div(period);
  }

  if (avgLoss.isZero()) {
    return new Decimal(100);
  }

  const rs = avgGain.div(avgLoss);
  const rsi = new Decimal(100).minus(
    new Decimal(100).div(new Decimal(1).plus(rs)),
  );
  return rsi.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function computeMacd(
  closes: Decimal[],
  fast: number = 12,
  slow: number = 26,
  signalPeriod: number = 9,
): { macd: Decimal; signal: Decimal; histogram: Decimal } | null {
  if (
    closes.length < slow + signalPeriod ||
    fast < 1 ||
    slow < 1 ||
    signalPeriod < 1
  ) {
    return null;
  }

  const fastMult = new Decimal(2).div(new Decimal(fast).plus(1));
  const slowMult = new Decimal(2).div(new Decimal(slow).plus(1));

  let fastEma = new Decimal(0);
  for (let i = 0; i < fast; i++) {
    fastEma = fastEma.plus(closes[i]);
  }
  fastEma = fastEma.div(fast);

  let slowEma = new Decimal(0);
  for (let i = 0; i < slow; i++) {
    slowEma = slowEma.plus(closes[i]);
  }
  slowEma = slowEma.div(slow);

  for (let i = fast; i < slow; i++) {
    fastEma = closes[i].minus(fastEma).times(fastMult).plus(fastEma);
  }

  const macdValues: Decimal[] = [];
  macdValues.push(fastEma.minus(slowEma));

  for (let i = slow; i < closes.length; i++) {
    fastEma = closes[i].minus(fastEma).times(fastMult).plus(fastEma);
    slowEma = closes[i].minus(slowEma).times(slowMult).plus(slowEma);
    macdValues.push(fastEma.minus(slowEma));
  }

  if (macdValues.length < signalPeriod) {
    return null;
  }

  const signalMult = new Decimal(2).div(new Decimal(signalPeriod).plus(1));
  let signalEma = new Decimal(0);
  for (let i = 0; i < signalPeriod; i++) {
    signalEma = signalEma.plus(macdValues[i]);
  }
  signalEma = signalEma.div(signalPeriod);

  for (let i = signalPeriod; i < macdValues.length; i++) {
    signalEma = macdValues[i]
      .minus(signalEma)
      .times(signalMult)
      .plus(signalEma);
  }

  const macdLine = macdValues[macdValues.length - 1];
  const histogram = macdLine.minus(signalEma);

  return {
    macd: macdLine.toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    signal: signalEma.toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    histogram: histogram.toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
  };
}

export function computeBollinger(
  closes: Decimal[],
  period: number = 20,
  stdMult: Decimal = new Decimal(2),
): { upper: Decimal; middle: Decimal; lower: Decimal } | null {
  if (closes.length < period || period < 2) {
    return null;
  }

  const window = closes.slice(-period);
  let sum = new Decimal(0);
  for (const v of window) {
    sum = sum.plus(v);
  }
  const middle = sum.div(period);

  let variance = new Decimal(0);
  for (const x of window) {
    variance = variance.plus(x.minus(middle).pow(2));
  }
  variance = variance.div(period);
  const stdDev = decimalSqrt(variance);

  const upper = middle.plus(stdMult.times(stdDev));
  const lower = middle.minus(stdMult.times(stdDev));

  return {
    upper: upper.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    middle: middle.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    lower: lower.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
  };
}

export function computeAtr(
  highs: Decimal[],
  lows: Decimal[],
  closes: Decimal[],
  period: number = 14,
): Decimal | null {
  const n = highs.length;
  if (
    n < period + 1 ||
    lows.length !== n ||
    closes.length !== n ||
    period < 1
  ) {
    return null;
  }

  const trueRanges: Decimal[] = [];
  for (let i = 1; i < n; i++) {
    const tr = Decimal.max(
      highs[i].minus(lows[i]),
      highs[i].minus(closes[i - 1]).abs(),
      lows[i].minus(closes[i - 1]).abs(),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  let atr = new Decimal(0);
  for (let i = 0; i < period; i++) {
    atr = atr.plus(trueRanges[i]);
  }
  atr = atr.div(period);

  for (let i = period; i < trueRanges.length; i++) {
    atr = atr
      .times(period - 1)
      .plus(trueRanges[i])
      .div(period);
  }

  return atr.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function computeVolumeRatio(
  volumes: Decimal[],
  period: number = 20,
): Decimal | null {
  if (volumes.length < period + 1 || period < 1) {
    return null;
  }

  let avg = new Decimal(0);
  const start = volumes.length - period - 1;
  for (let i = start; i < volumes.length - 1; i++) {
    avg = avg.plus(volumes[i]);
  }
  avg = avg.div(period);

  if (avg.isZero()) {
    return null;
  }

  const current = volumes[volumes.length - 1];
  return current.div(avg).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function computeObi(
  bids: Array<Record<string, unknown>>,
  asks: Array<Record<string, unknown>>,
): Decimal {
  let bidVol = new Decimal(0);
  for (const b of bids) {
    bidVol = bidVol.plus(new Decimal(String(b.q ?? 0)));
  }
  let askVol = new Decimal(0);
  for (const a of asks) {
    askVol = askVol.plus(new Decimal(String(a.q ?? 0)));
  }
  const total = bidVol.plus(askVol);
  if (total.isZero()) {
    return new Decimal(0);
  }
  return bidVol
    .minus(askVol)
    .div(total)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export function computeSpreadPct(bid: Decimal, ask: Decimal): Decimal {
  const mid = bid.plus(ask).div(2);
  if (mid.isZero()) {
    return new Decimal(0);
  }
  return ask
    .minus(bid)
    .div(mid)
    .times(100)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export function computePriceChangePct(
  current: Decimal,
  previous: Decimal,
): Decimal {
  if (previous.isZero()) {
    return new Decimal(0);
  }
  return current
    .minus(previous)
    .div(previous)
    .times(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
