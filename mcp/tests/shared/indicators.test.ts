import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";

import {
  computeEma,
  computeSma,
  computeRsi,
  computeMacd,
  computeBollinger,
  computeAtr,
  computeVolumeRatio,
  computeObi,
  computeSpreadPct,
  computePriceChangePct,
} from "../../src/shared/indicators/core.js";

import { evaluateAlert } from "../../src/shared/indicators/evaluators.js";

import type { MarketSnapshot } from "../../src/shared/indicators/evaluators.js";

function dec(values: (string | number)[]): Decimal[] {
  return values.map((v) => new Decimal(String(v)));
}

function makeCandles(
  closes: (string | number)[],
  opts?: {
    highs?: (string | number)[];
    lows?: (string | number)[];
    volumes?: (string | number)[];
  },
): Array<Record<string, unknown>> {
  const n = closes.length;
  const highs = opts?.highs ?? closes;
  const lows = opts?.lows ?? closes;
  const volumes = opts?.volumes ?? Array(n).fill(100);
  return Array.from({ length: n }, (_, i) => ({
    close: String(closes[i]),
    high: String(highs[i]),
    low: String(lows[i]),
    open: String(closes[i]),
    volume: String(volumes[i]),
    timestamp: i,
  }));
}

describe("computeEma", () => {
  it("basic EMA", () => {
    const values = dec([10, 11, 12, 13, 14, 15]);
    const result = computeEma(values, 3);
    expect(result).not.toBeNull();
    expect(result!.gt(13)).toBe(true);
  });

  it("insufficient data returns null", () => {
    const values = dec([10, 11]);
    expect(computeEma(values, 5)).toBeNull();
  });

  it("single period returns the value", () => {
    const values = dec([42]);
    const result = computeEma(values, 1);
    expect(result).not.toBeNull();
    expect(result!.eq(42)).toBe(true);
  });
});

describe("computeSma", () => {
  it("basic SMA", () => {
    const values = dec([10, 20, 30, 40, 50]);
    const result = computeSma(values, 3);
    expect(result).not.toBeNull();
    expect(result!.eq(40)).toBe(true); // (30+40+50)/3
  });

  it("insufficient data returns null", () => {
    expect(computeSma(dec([10]), 5)).toBeNull();
  });
});

describe("computeRsi", () => {
  it("all gains → RSI = 100", () => {
    const closes = dec(Array.from({ length: 19 }, (_, i) => i + 1));
    const rsi = computeRsi(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!.toFixed(2)).toBe("100.00");
  });

  it("all losses → RSI near 0", () => {
    const closes = dec(Array.from({ length: 19 }, (_, i) => 20 - i));
    const rsi = computeRsi(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!.lt(1)).toBe(true);
  });

  it("mixed movement → RSI between 0 and 100", () => {
    const closes = dec([
      100, 102, 101, 103, 100, 104, 99, 105, 98, 106, 97, 107, 96, 108, 95, 109,
    ]);
    const rsi = computeRsi(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!.gt(0)).toBe(true);
    expect(rsi!.lt(100)).toBe(true);
  });

  it("insufficient data returns null", () => {
    const closes = dec([100, 101, 102]);
    expect(computeRsi(closes, 14)).toBeNull();
  });
});

describe("computeMacd", () => {
  it("uptrend → positive MACD", () => {
    const closes = dec(Array.from({ length: 49 }, (_, i) => (i + 1) * 10));
    const result = computeMacd(closes, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result!.macd.gt(0)).toBe(true);
  });

  it("insufficient data returns null", () => {
    const closes = dec([100, 101, 102]);
    expect(computeMacd(closes)).toBeNull();
  });

  it("returns macd, signal, histogram", () => {
    const closes = dec(Array.from({ length: 50 }, (_, i) => 100 + i));
    const result = computeMacd(closes, 12, 26, 9);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("macd");
    expect(result).toHaveProperty("signal");
    expect(result).toHaveProperty("histogram");
  });
});

describe("computeBollinger", () => {
  it("flat price → tight bands at price", () => {
    const closes = dec(Array(25).fill(100));
    const result = computeBollinger(closes, 20);
    expect(result).not.toBeNull();
    expect(result!.middle.toFixed(2)).toBe("100.00");
    expect(result!.upper.toFixed(2)).toBe("100.00");
    expect(result!.lower.toFixed(2)).toBe("100.00");
  });

  it("volatile prices → wider bands", () => {
    const vals: number[] = [];
    for (let i = 0; i < 15; i++) {
      vals.push(90, 110);
    }
    const closes = dec(vals);
    const result = computeBollinger(closes, 20);
    expect(result).not.toBeNull();
    const { upper, middle, lower } = result!;
    expect(upper.gt(middle)).toBe(true);
    expect(middle.gt(lower)).toBe(true);
    expect(upper.minus(lower).gt(10)).toBe(true);
  });

  it("insufficient data returns null", () => {
    const closes = dec([100, 101]);
    expect(computeBollinger(closes, 20)).toBeNull();
  });
});

describe("computeAtr", () => {
  it("flat market → low ATR", () => {
    const n = 20;
    const highs = dec(Array(n).fill(101));
    const lows = dec(Array(n).fill(99));
    const closes = dec(Array(n).fill(100));
    const atr = computeAtr(highs, lows, closes, 14);
    expect(atr).not.toBeNull();
    expect(atr!.toFixed(2)).toBe("2.00");
  });

  it("volatile market → high ATR", () => {
    const n = 20;
    const highs = dec(Array(n).fill(120));
    const lows = dec(Array(n).fill(80));
    const closes = dec(Array(n).fill(100));
    const atr = computeAtr(highs, lows, closes, 14);
    expect(atr).not.toBeNull();
    expect(atr!.gt(30)).toBe(true);
  });

  it("insufficient data returns null", () => {
    expect(computeAtr(dec([100]), dec([99]), dec([100]), 14)).toBeNull();
  });
});

describe("computeVolumeRatio", () => {
  it("normal volume → ratio 1.00", () => {
    const volumes = dec([...Array(21).fill(100), 100]);
    const ratio = computeVolumeRatio(volumes, 20);
    expect(ratio).not.toBeNull();
    expect(ratio!.toFixed(2)).toBe("1.00");
  });

  it("spike volume → ratio 5.00", () => {
    const volumes = dec([...Array(21).fill(100), 500]);
    const ratio = computeVolumeRatio(volumes, 20);
    expect(ratio).not.toBeNull();
    expect(ratio!.toFixed(2)).toBe("5.00");
  });

  it("insufficient data returns null", () => {
    const volumes = dec(Array(5).fill(100));
    expect(computeVolumeRatio(volumes, 20)).toBeNull();
  });
});

describe("computeObi", () => {
  it("balanced book → OBI = 0", () => {
    const bids = [{ q: "100" }, { q: "100" }];
    const asks = [{ q: "100" }, { q: "100" }];
    expect(computeObi(bids, asks).toFixed(4)).toBe("0.0000");
  });

  it("buy pressure → positive OBI", () => {
    const bids = [{ q: "300" }];
    const asks = [{ q: "100" }];
    const obi = computeObi(bids, asks);
    expect(obi.gt(0)).toBe(true);
    expect(obi.toFixed(4)).toBe("0.5000");
  });

  it("sell pressure → negative OBI", () => {
    const bids = [{ q: "100" }];
    const asks = [{ q: "300" }];
    const obi = computeObi(bids, asks);
    expect(obi.lt(0)).toBe(true);
  });

  it("empty book → OBI = 0", () => {
    expect(computeObi([], []).toFixed(4)).toBe("0.0000");
  });
});

describe("computeSpreadPct", () => {
  it("basic spread", () => {
    const spread = computeSpreadPct(new Decimal("99"), new Decimal("101"));
    expect(spread.gt(0)).toBe(true);
    expect(spread.toFixed(4)).toBe("2.0000");
  });

  it("tight spread", () => {
    const spread = computeSpreadPct(
      new Decimal("99.99"),
      new Decimal("100.01"),
    );
    expect(spread.lt(new Decimal("0.1"))).toBe(true);
  });

  it("zero mid → spread = 0", () => {
    expect(
      computeSpreadPct(new Decimal("0"), new Decimal("0")).toFixed(4),
    ).toBe("0.0000");
  });
});

describe("computePriceChangePct", () => {
  it("increase", () => {
    const pct = computePriceChangePct(new Decimal("110"), new Decimal("100"));
    expect(pct.toFixed(2)).toBe("10.00");
  });

  it("decrease", () => {
    const pct = computePriceChangePct(new Decimal("90"), new Decimal("100"));
    expect(pct.toFixed(2)).toBe("-10.00");
  });

  it("no change", () => {
    const pct = computePriceChangePct(new Decimal("100"), new Decimal("100"));
    expect(pct.toFixed(2)).toBe("0.00");
  });

  it("zero previous → 0", () => {
    expect(
      computePriceChangePct(new Decimal("100"), new Decimal("0")).toFixed(2),
    ).toBe("0.00");
  });
});

describe("evaluateAlert — price", () => {
  it("price above triggered", () => {
    const alert = {
      alert_type: "price",
      config_json: JSON.stringify({ direction: "above", threshold: "100" }),
    };
    const snap: MarketSnapshot = { price: new Decimal("105") };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });

  it("price above not triggered", () => {
    const alert = {
      alert_type: "price",
      config_json: JSON.stringify({ direction: "above", threshold: "100" }),
    };
    const snap: MarketSnapshot = { price: new Decimal("95") };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(false);
  });

  it("price below triggered", () => {
    const alert = {
      alert_type: "price",
      config_json: JSON.stringify({ direction: "below", threshold: "100" }),
    };
    const snap: MarketSnapshot = { price: new Decimal("95") };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });

  it("no price data → conditionMet false", () => {
    const alert = {
      alert_type: "price",
      config_json: JSON.stringify({ direction: "above", threshold: "100" }),
    };
    const snap: MarketSnapshot = {};
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(false);
  });

  it("reads from config_json, not column values", () => {
    const alert = {
      alert_type: "price",
      direction: "above",
      threshold: "0",
      config_json: JSON.stringify({ direction: "below", threshold: "100" }),
    };
    const snap: MarketSnapshot = { price: new Decimal("95") };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });
});

describe("evaluateAlert — rsi", () => {
  it("overbought triggered", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const alert = {
      alert_type: "rsi",
      config_json: JSON.stringify({
        period: 14,
        direction: "above",
        threshold: "50",
      }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("129"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });

  it("insufficient data → conditionMet false", () => {
    const candles = makeCandles([100, 101, 102]);
    const alert = {
      alert_type: "rsi",
      config_json: JSON.stringify({
        period: 14,
        direction: "above",
        threshold: "70",
      }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("102"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(false);
  });
});

describe("evaluateAlert — ema_cross", () => {
  it("bullish crossover triggered", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const alert = {
      alert_type: "ema_cross",
      config_json: JSON.stringify({
        fast_period: 5,
        slow_period: 20,
        direction: "bullish",
      }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("149"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });

  it("bearish crossover triggered", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 150 - i);
    const candles = makeCandles(closes);
    const alert = {
      alert_type: "ema_cross",
      config_json: JSON.stringify({
        fast_period: 5,
        slow_period: 20,
        direction: "bearish",
      }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("101"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });
});

describe("evaluateAlert — macd", () => {
  it("bullish MACD triggered", () => {
    const closes = [
      ...Array(30).fill(100),
      ...Array.from({ length: 20 }, (_, i) => 100 + (i + 1) * 3),
    ];
    const candles = makeCandles(closes);
    const alert = {
      alert_type: "macd",
      config_json: JSON.stringify({
        fast: 12,
        slow: 26,
        signal: 9,
        direction: "bullish",
      }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal(String(closes[closes.length - 1])),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });
});

describe("evaluateAlert — bollinger", () => {
  it("price above upper band triggered", () => {
    const closes = [...Array(20).fill(100), 120];
    const candles = makeCandles(closes);
    const alert = {
      alert_type: "bollinger",
      config_json: JSON.stringify({
        period: 20,
        std_mult: "2",
        band: "upper",
      }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("120"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });
});

describe("evaluateAlert — volume_spike", () => {
  it("volume spike detected", () => {
    const volumes = [...Array(21).fill(100), 500];
    const closes = Array(22).fill(100);
    const candles = makeCandles(closes, { volumes });
    const alert = {
      alert_type: "volume_spike",
      config_json: JSON.stringify({ period: 20, multiplier: "2.0" }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("100"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });
});

describe("evaluateAlert — spread", () => {
  it("wide spread triggered", () => {
    const alert = {
      alert_type: "spread",
      config_json: JSON.stringify({ direction: "above", threshold: "0.5" }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("100"),
      bid: new Decimal("99"),
      ask: new Decimal("101"),
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true); // 2% > 0.5%
  });

  it("tight spread not triggered", () => {
    const alert = {
      alert_type: "spread",
      config_json: JSON.stringify({ direction: "above", threshold: "3.0" }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("100"),
      bid: new Decimal("99.99"),
      ask: new Decimal("100.01"),
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(false);
  });
});

describe("evaluateAlert — obi", () => {
  it("buy pressure triggered", () => {
    const alert = {
      alert_type: "obi",
      config_json: JSON.stringify({ direction: "above", threshold: "0.3" }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("100"),
      orderBook: { bids: [{ q: "300" }], asks: [{ q: "100" }] },
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });

  it("no order book → conditionMet false", () => {
    const alert = {
      alert_type: "obi",
      config_json: JSON.stringify({ direction: "above", threshold: "0.3" }),
    };
    const snap: MarketSnapshot = { price: new Decimal("100") };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(false);
  });
});

describe("evaluateAlert — price_change_pct", () => {
  it("big price increase triggered", () => {
    const closes = [...Array(24).fill(100), 115];
    const candles = makeCandles(closes);
    const alert = {
      alert_type: "price_change_pct",
      config_json: JSON.stringify({
        lookback: 24,
        direction: "rise",
        threshold: "5.0",
      }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("115"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });
});

describe("evaluateAlert — atr_breakout", () => {
  it("breakout detected", () => {
    const n = 20;
    const highs = Array(n).fill(101);
    const lows = Array(n).fill(99);
    const closes = Array(n).fill(100);
    const candles = makeCandles(closes, { highs, lows });
    const alert = {
      alert_type: "atr_breakout",
      config_json: JSON.stringify({ period: 14, multiplier: "1.5" }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("110"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(true);
  });

  it("no breakout", () => {
    const n = 20;
    const highs = Array(n).fill(101);
    const lows = Array(n).fill(99);
    const closes = Array(n).fill(100);
    const candles = makeCandles(closes, { highs, lows });
    const alert = {
      alert_type: "atr_breakout",
      config_json: JSON.stringify({ period: 14, multiplier: "1.5" }),
    };
    const snap: MarketSnapshot = {
      price: new Decimal("101"),
      candles,
    };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(false);
  });
});

describe("evaluateAlert — unknown type", () => {
  it("unknown type returns conditionMet false", () => {
    const alert = { alert_type: "nonexistent" };
    const snap: MarketSnapshot = { price: new Decimal("100") };
    const result = evaluateAlert(alert, snap);
    expect(result.conditionMet).toBe(false);
  });
});
