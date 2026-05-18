import { promises as fs } from "node:fs";
import type { LivePriceSource, ScenarioCandle } from "../types.js";
import { parseContent } from "../format/parse.js";

export async function loadFileCandles(path: string): Promise<ScenarioCandle[]> {
  const raw = await fs.readFile(path, "utf8");
  return parseContent(raw, path);
}

export async function fileLiveSource(path: string): Promise<LivePriceSource> {
  const candles = await loadFileCandles(path);
  let i = 0;
  return {
    async next() {
      if (i >= candles.length) return null;
      const c = candles[i];
      i++;
      return { price: c.close, timestamp: c.start };
    },
  };
}
