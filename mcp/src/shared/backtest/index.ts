export { createGrid, runBacktest, optimizeGridParams } from "./engine.js";

export type { BacktestResult, OptimizationResult } from "./engine.js";

export {
  runMartingaleBacktest,
  optimizeMartingaleParams,
} from "./martingale-engine.js";
export type {
  MartingaleBacktestParams,
  MartingaleBacktestResult,
  MartingaleOptimizationResult,
} from "./martingale-engine.js";
