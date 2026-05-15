import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir, ensureConfigDir } from "@revolut/revolut-x-api";

export interface GridLevelPosition {
  id: string;
  baseHeld: string;
  fillCost: string;
  sellOrderId: string | null;
}

export interface GridLevelState {
  index: number;
  price: string;
  buyOrderIds: string[];
  positions: GridLevelPosition[];
}

export interface GridTradeEntry {
  ts: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  profit?: string;
  fee?: string;
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
    trailingUp?: boolean;
    stopLoss?: string;
  };
  splitExecuted: boolean;
  shiftCount?: number;
  gridPrice: string;
  quotePrecision: string;
  basePrecision: string;
  quotePerLevel: string;
  levels: GridLevelState[];
  stats: {
    totalBuys: number;
    totalSells: number;
    realizedPnl: string;
    totalFees: string;
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

// Migrate saved state from the old single-slot format (buyOrderId / sellOrderId /
// hasPosition / baseHeld / fillCost) to the new multi-slot format.
function migrateStateIfNeeded(raw: Record<string, unknown>): void {
  const levels = raw.levels as Array<Record<string, unknown>> | undefined;
  if (!levels || !Array.isArray(levels) || levels.length === 0) return;

  // Already migrated if first level has the new shape
  if (Array.isArray(levels[0].buyOrderIds)) return;

  // First pass: build new fields, temporarily leave sellOrderId on each raw level
  for (const lv of levels) {
    const oldBuyId = lv.buyOrderId as string | null;
    const oldHasPos = Boolean(lv.hasPosition);
    const oldBase = String(lv.baseHeld ?? "0");
    const oldCost = String(lv.fillCost ?? "0");
    const idx = Number(lv.index ?? 0);

    lv.buyOrderIds = oldBuyId ? [oldBuyId] : [];
    lv.positions = oldHasPos && parseFloat(oldBase) > 0
      ? [{ id: `migrated-${idx}`, baseHeld: oldBase, fillCost: oldCost, sellOrderId: null }]
      : [];
  }

  // Second pass: assign old sellOrderId from level N+1 to the position on level N
  for (const lv of levels) {
    const oldSellId = lv.sellOrderId as string | null;
    if (!oldSellId) continue;
    const idx = Number(lv.index ?? 0);
    const buyLv = levels[idx - 1];
    const positions = buyLv?.positions as Array<Record<string, unknown>> | undefined;
    if (positions && positions.length > 0) {
      positions[0].sellOrderId = oldSellId;
    }
  }

  // Third pass: remove old fields
  for (const lv of levels) {
    delete lv.buyOrderId;
    delete lv.sellOrderId;
    delete lv.hasPosition;
    delete lv.baseHeld;
    delete lv.fillCost;
  }
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
      const raw = data as Record<string, unknown>;
      // Legacy field name migration
      if (!raw.quotePerLevel && raw.usdPerLevel) {
        raw.quotePerLevel = raw.usdPerLevel;
      }
      const state = raw as unknown as GridState;
      if (state.stats && state.stats.totalFees == null) {
        state.stats.totalFees = "0";
      }
      migrateStateIfNeeded(raw);
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
