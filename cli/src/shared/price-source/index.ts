export type {
  ScenarioCandle,
  BatchPriceSource,
  LivePriceSource,
  PriceSpec,
  PriceSpecKind,
  PriceTick,
  GeneratorType,
  GeneratorParams,
} from "./types.js";

export { parseSpec, PriceSpecError } from "./spec.js";
export {
  TickerPriceProvider,
  resolveTickerPrice,
  loadApiCandles,
  parseApiCandles,
} from "./sources/api.js";
export { parseContent, parseLineToTick, ParseError } from "./format/parse.js";

export {
  loadBatch,
  createLiveProvider,
  isScenarioSpec,
  type BatchSourceContext,
  type LiveSourceContext,
} from "./factory.js";
export { withCachedPeek } from "./adapt.js";
