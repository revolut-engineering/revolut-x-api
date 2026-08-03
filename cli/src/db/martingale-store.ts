import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir, ensureConfigDir } from "@revolut/revolut-x-api";
import type { StatusMessageRefs } from "./store.js";

export interface MartingaleLevelState {
  index: number;
  price: string;
  quoteSize: string;
  buyOrderIds: string[];
  filled: boolean;
}

export interface MartingaleTradeEntry {
  ts: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  reason: "initial" | "safety" | "tp" | "sl";
  profit?: string;
  fee?: string;
  orderId: string;
}

export interface MartingaleState {
  id: string;
  pair: string;
  version: number;
  createdAt: string;
  updatedAt: string;

  config: {
    priceDeviation: string;
    safetyOrderVolumeScale: string;
    maxSafetyOrders: number;
    takeProfit: string;
    stopLoss: string;
    investment: string;
    intervalSec: number;
    dryRun: boolean;
  };

  // Cycle state
  inPosition: boolean;
  safetyOrdersFilled: number;
  totalQty: string;
  totalCost: string;
  avgEntryPrice: string;
  initialBuyPrice: string | null;
  lastBuyPrice: string | null;
  tpOrderId: string | null;
  stopLossPrice: string | null;

  // Precision from exchange pair info
  quotePrecision: string;
  basePrecision: string;

  // Levels (recomputed each cycle from config + entry price)
  levels: MartingaleLevelState[];

  stats: {
    completedCycles: number;
    winningCycles: number;
    realizedPnl: string;
    totalFees: string;
    totalBuys: number;
    totalSells: number;
  };

  tradeLog: MartingaleTradeEntry[];
  statusMessages?: StatusMessageRefs;
}

const STATE_PREFIX = "martingale_state_";
const MAX_TRADE_LOG = 500;

function stateFileName(pair: string): string {
  return `${STATE_PREFIX}${pair.replace(/[^a-zA-Z0-9-]/g, "_")}.json`;
}

function stateFilePath(pair: string): string {
  return join(getConfigDir(), stateFileName(pair));
}

export function saveMartingaleState(state: MartingaleState): void {
  ensureConfigDir();
  state.updatedAt = new Date().toISOString();
  if (state.tradeLog.length > MAX_TRADE_LOG) {
    state.tradeLog = state.tradeLog.slice(-MAX_TRADE_LOG);
  }
  const path = stateFilePath(state.pair);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function loadMartingaleState(pair: string): MartingaleState | null {
  const path = stateFilePath(pair);
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (data && typeof data === "object" && "id" in data) {
      const state = data as MartingaleState;
      if (!state.stats.totalFees) state.stats.totalFees = "0";
      if (!state.stats.totalBuys) state.stats.totalBuys = 0;
      if (!state.stats.totalSells) state.stats.totalSells = 0;
      return state;
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteMartingaleState(pair: string): boolean {
  const path = stateFilePath(pair);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
