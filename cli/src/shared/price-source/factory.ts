import type { RevolutXClient } from "@revolut/revolut-x-api";
import { PriceSpecError } from "./spec.js";
import type { LivePriceSource, PriceSpec, ScenarioCandle } from "./types.js";
import { inlineCandles, inlineLiveSource } from "./sources/inline.js";
import { generatorCandles, generatePrices } from "./sources/generators.js";
import { loadFileCandles, fileLiveSource } from "./sources/file.js";
import { loadStdinCandles, stdinLiveSource } from "./sources/stdin.js";
import { interactiveLiveSource } from "./sources/interactive.js";
import { loadApiCandles, OrderBookMidProvider } from "./sources/api.js";

export interface BatchSourceContext {
  apiClient?: RevolutXClient;
  apiPair?: string;
  apiInterval?: string;
  apiDays?: number;
}

export async function loadBatch(
  spec: PriceSpec,
  ctx: BatchSourceContext = {},
): Promise<ScenarioCandle[]> {
  switch (spec.kind) {
    case "api": {
      if (
        !ctx.apiClient ||
        !ctx.apiPair ||
        !ctx.apiInterval ||
        ctx.apiDays === undefined
      ) {
        throw new PriceSpecError(
          "api source requires client, pair, interval, and days",
        );
      }
      return loadApiCandles({
        client: ctx.apiClient,
        pair: ctx.apiPair,
        interval: ctx.apiInterval,
        days: ctx.apiDays,
      });
    }
    case "inline":
      return inlineCandles(spec.values);
    case "gen":
      return generatorCandles(spec.gen.type, spec.gen.params);
    case "file":
      return loadFileCandles(spec.path);
    case "stdin":
      return loadStdinCandles();
    case "interactive":
      throw new PriceSpecError(
        "interactive price source cannot be used for backtest/optimize (no live loop)",
      );
  }
}

export interface LiveSourceContext {
  apiClient?: RevolutXClient;
  apiPair?: string;
  apiIntervalSec?: number;
}

export async function createLiveProvider(
  spec: PriceSpec,
  ctx: LiveSourceContext = {},
): Promise<LivePriceSource> {
  switch (spec.kind) {
    case "api": {
      if (!ctx.apiClient || !ctx.apiPair || ctx.apiIntervalSec === undefined) {
        throw new PriceSpecError(
          "api live source requires client, pair, and intervalSec",
        );
      }
      return new OrderBookMidProvider({
        client: ctx.apiClient,
        pair: ctx.apiPair,
        intervalSec: ctx.apiIntervalSec,
      });
    }
    case "inline":
      return inlineLiveSource(spec.values);
    case "gen":
      return inlineLiveSource(generatePrices(spec.gen.type, spec.gen.params));
    case "file":
      return fileLiveSource(spec.path);
    case "stdin":
      return stdinLiveSource();
    case "interactive":
      return interactiveLiveSource();
  }
}

export function isScenarioSpec(spec: PriceSpec): boolean {
  return spec.kind !== "api";
}
