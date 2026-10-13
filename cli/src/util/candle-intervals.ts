const CANDLE_INTERVAL_MINUTES = {
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
} as const;

type CandleInterval = keyof typeof CANDLE_INTERVAL_MINUTES;

export const CANDLE_INTERVALS = Object.keys(
  CANDLE_INTERVAL_MINUTES,
) as CandleInterval[];

export function candleIntervalMinutes(name: string): number | undefined {
  return Object.hasOwn(CANDLE_INTERVAL_MINUTES, name)
    ? CANDLE_INTERVAL_MINUTES[name as CandleInterval]
    : undefined;
}

export function candleIntervalMs(name: string): number {
  const minutes = candleIntervalMinutes(name);
  if (minutes === undefined) {
    throw new Error(`Unknown candle interval '${name}'.`);
  }
  return minutes * 60_000;
}
