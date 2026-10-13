export {
  annualizedReturnPct,
  candleCoverage,
  returnOverDrawdown,
  createGrid,
  runBacktest,
  optimizeGridParams,
} from "./engine.js";
export { TAKER_FEE_RATE } from "./grid-math.js";
export {
  constraintsFromPair,
  createGridPlan,
  quotePerLevelFor,
  type GridOrderConstraints,
} from "./grid-plan.js";

export type {
  BacktestCandle,
  BacktestResult,
  OptimizationResult,
} from "./engine.js";
