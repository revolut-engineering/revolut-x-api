import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir, ensureConfigDir } from "revolutx-api";

export interface GridLevelState {
  index: number;
  price: string;
  buyOrderId: string | null;
  sellOrderId: string | null;
  hasPosition: boolean;
  baseHeld: string;
  fillCost: string;
}

export interface GridTradeEntry {
  ts: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  profit?: string;
  orderId: string;
}

export interface GridState {
  id: string;
  pair: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  config: {
    levels: number;
    rangePct: string;
    investment: string;
    splitInvestment: boolean;
    intervalSec: number;
    dryRun: boolean;
  };
  splitExecuted: boolean;
  gridPrice: string;
  quotePrecision: string;
  basePrecision: string;
  quotePerLevel: string;
  levels: GridLevelState[];
  stats: {
    totalBuys: number;
    totalSells: number;
    realizedPnl: string;
  };
  tradeLog: GridTradeEntry[];
}

const STATE_PREFIX = "grid_state_";
const MAX_TRADE_LOG = 500;

function stateFileName(pair: string): string {
  return `${STATE_PREFIX}${pair.replace(/[^a-zA-Z0-9-]/g, "_")}.json`;
}

function stateFilePath(pair: string): string {
  return join(getConfigDir(), stateFileName(pair));
}

export function saveGridState(state: GridState): void {
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

export function loadGridState(pair: string): GridState | null {
  const path = stateFilePath(pair);
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (data && typeof data === "object" && "id" in data) {
      const state = data as GridState;
      if (
        !state.quotePerLevel &&
        (data as Record<string, unknown>).usdPerLevel
      ) {
        state.quotePerLevel = (data as Record<string, unknown>)
          .usdPerLevel as string;
      }
      return state;
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteGridState(pair: string): boolean {
  const path = stateFilePath(pair);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function listGridStates(): string[] {
  const dir = getConfigDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(STATE_PREFIX) && f.endsWith(".json"))
      .map((f) => f.slice(STATE_PREFIX.length, -5).replace(/_/g, "-"));
  } catch {
    return [];
  }
}
