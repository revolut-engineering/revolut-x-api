import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import {
  getConfigDir,
  ensureConfigDir,
  isMissing,
  redactHome,
  writeFileAtomic,
} from "@revolut/revolut-x-api";
import type { StatusMessageRefs } from "./store.js";
import { unreadableFileAdvice } from "../util/file-advice.js";

export interface GridLevelPosition {
  id: string;
  baseHeld: string;
  fillCost: string;
  sellOrderId: string | null;
  slotQuote?: string;
  sellBaseSize?: string;
  sellClientOrderId?: string;
}

export interface GridLevelState {
  index: number;
  price: string;
  buyOrderIds: string[];
  positions: GridLevelPosition[];
  expectedBuys?: number;
  pendingBuyClientOrderIds?: string[];
  pendingBuyQuoteSizes?: Record<string, string>;
  buyOrderQuoteSizes?: Record<string, string>;
  buyClientOrderIds?: Record<string, string>;
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

export type GridHaltReason = "stop-loss" | "rejected-orders";

export interface GridHalt {
  reason: GridHaltReason;
  triggerPrice?: string;
  clientOrderId?: string;
  orderId?: string;
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
  initializing?: boolean;
  splitOrderId?: string;
  splitClientOrderId?: string;
  splitOrderQuoteSize?: string;
  missingSince?: Record<string, string>;
  splitRemainingQuote?: string;
  splitAccumulatedBase?: string;
  splitAccumulatedAmount?: string;
  splitAccumulatedFee?: string;
  splitAccountingApplied?: boolean;
  halt?: GridHalt;
  stopped?: boolean;
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
  statusMessages?: StatusMessageRefs;
}

const STATE_PREFIX = "grid_state_";
const MAX_TRADE_LOG = 500;

function gridFileStem(pair: string): string {
  return join(
    getConfigDir(),
    `${STATE_PREFIX}${pair.replace(/[^a-zA-Z0-9-]/g, "_")}`,
  );
}

function stateFilePath(pair: string): string {
  return `${gridFileStem(pair)}.json`;
}

export function gridLockFilePath(pair: string): string {
  return `${gridFileStem(pair)}.lock`;
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
    lv.positions =
      oldHasPos && parseFloat(oldBase) > 0
        ? [
            {
              id: `migrated-${idx}`,
              baseHeld: oldBase,
              fillCost: oldCost,
              sellOrderId: null,
            },
          ]
        : [];
  }

  // Second pass: assign old sellOrderId from level N+1 to the position on level N
  for (const lv of levels) {
    const oldSellId = lv.sellOrderId as string | null;
    if (!oldSellId) continue;
    const idx = Number(lv.index ?? 0);
    const buyLv = levels[idx - 1];
    const positions = buyLv?.positions as
      | Array<Record<string, unknown>>
      | undefined;
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
  writeFileAtomic(stateFilePath(state.pair), JSON.stringify(state, null, 2));
}

function adoptLegacyStopLoss(raw: Record<string, unknown>): void {
  if (!("stopLossClientOrderId" in raw)) return;
  const clientOrderId = raw.stopLossClientOrderId;
  delete raw.stopLossClientOrderId;
  if (raw.halt || typeof clientOrderId !== "string" || !clientOrderId) return;
  raw.halt = { reason: "stop-loss", clientOrderId };
}

function assignLeftoverSlots(state: GridState): void {
  for (const level of state.levels) {
    const unslotted = level.positions.filter(
      (position) => position.slotQuote === undefined,
    );
    if (unslotted.length === 0) continue;
    const perLevel = new Decimal(state.quotePerLevel);
    const leftovers = [
      ...level.buyOrderIds.map((id) => level.buyOrderQuoteSizes?.[id]),
      ...(level.pendingBuyClientOrderIds ?? []).map(
        (id) => level.pendingBuyQuoteSizes?.[id],
      ),
    ]
      .filter((size): size is string => size !== undefined)
      .map((size) => new Decimal(size))
      .filter((size) => size.lt(perLevel));
    const costed: Array<{ position: GridLevelPosition; cost: Decimal }> = [];
    for (const position of unslotted) {
      const cost = positiveDecimal(position.fillCost);
      if (cost) costed.push({ position, cost });
      else position.slotQuote = perLevel.toString();
    }
    costed.sort((a, b) => b.cost.comparedTo(a.cost));
    const held = [...costed.map((entry) => entry.cost), ...leftovers].reduce(
      (sum, amount) => sum.plus(amount),
      new Decimal(0),
    );
    if (costed.length > 0 && held.lte(perLevel)) {
      const [largest, ...others] = costed;
      const othersCost = others.reduce(
        (sum, entry) => sum.plus(entry.cost),
        new Decimal(0),
      );
      const leftoverTotal = leftovers.reduce(
        (sum, amount) => sum.plus(amount),
        new Decimal(0),
      );
      largest.position.slotQuote = perLevel
        .minus(othersCost)
        .minus(leftoverTotal)
        .toString();
      for (const { position, cost } of others) {
        position.slotQuote = cost.toString();
      }
      continue;
    }
    leftovers.sort((a, b) => b.comparedTo(a));
    for (const { position, cost } of costed) {
      const index = leftovers.findIndex((leftover) =>
        cost.plus(leftover).lte(perLevel),
      );
      const leftover =
        index >= 0 ? leftovers.splice(index, 1)[0] : new Decimal(0);
      position.slotQuote = perLevel.minus(leftover).toString();
    }
  }
}

function positiveDecimal(value: string | undefined): Decimal | null {
  try {
    const amount = new Decimal(value ?? "");
    return amount.gt(0) ? amount : null;
  } catch {
    return null;
  }
}

export class GridStateDamagedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`The saved grid file ${redactHome(path)} is damaged (${reason})`);
    this.name = "GridStateDamagedError";
  }
}

export class GridStateUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(
      code === "EISDIR"
        ? `The saved grid file ${redactHome(path)} is a folder, not a file. Nothing was started. Move it aside, then run again.`
        : `The saved grid file ${redactHome(path)} can't be read (${code}). Nothing was started. ${unreadableFileAdvice(path, code)} Then run again.`,
    );
    this.name = "GridStateUnreadableError";
  }
}

export function loadGridState(pair: string): GridState | null {
  const path = stateFilePath(pair);
  if (isMissing(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new GridStateUnreadableError(
      path,
      (err as NodeJS.ErrnoException).code ?? "read error",
    );
  }
  try {
    const data: unknown = JSON.parse(text);
    if (
      !data ||
      typeof data !== "object" ||
      !("id" in data) ||
      !Array.isArray((data as Record<string, unknown>).levels)
    ) {
      throw new Error("it is not a grid save file");
    }
    const raw = data as Record<string, unknown>;
    if (!raw.quotePerLevel && raw.usdPerLevel) {
      raw.quotePerLevel = raw.usdPerLevel;
    }
    const state = raw as unknown as GridState;
    if (state.stats && state.stats.totalFees == null) {
      state.stats.totalFees = "0";
    }
    migrateStateIfNeeded(raw);
    adoptLegacyStopLoss(raw);
    assignLeftoverSlots(state);
    return state;
  } catch (err) {
    throw new GridStateDamagedError(
      path,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function setAsideGridState(pair: string): string {
  const path = stateFilePath(pair);
  const target = `${path}.damaged-${Date.now()}`;
  renameSync(path, target);
  return target;
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
