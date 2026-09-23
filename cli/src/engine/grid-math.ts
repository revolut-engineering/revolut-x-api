import { Decimal } from "decimal.js";
import {
  MAKER_FEE_RATE as MAKER_FEE_RATE_RAW,
  TAKER_FEE_RATE as TAKER_FEE_RATE_RAW,
} from "@revolut/revolut-x-api";
import type { GridLevelState } from "../db/grid-store.js";

export const MAKER_FEE_RATE = new Decimal(MAKER_FEE_RATE_RAW);
export const TAKER_FEE_RATE = new Decimal(TAKER_FEE_RATE_RAW);

export function levelsPerSide(totalLevels: number): number {
  return totalLevels / 2;
}

export function findFirstGeometricShiftAbovePrice(
  boundaryPrice: Decimal,
  ratio: Decimal,
  targetPrice: Decimal,
  minimumShift: number,
): number {
  if (!boundaryPrice.isFinite() || !boundaryPrice.gt(0)) {
    throw new Error("Shift boundary price must be finite and positive.");
  }
  if (!ratio.isFinite() || !ratio.gt(1)) {
    throw new Error("Shift ratio must be finite and greater than one.");
  }
  if (!targetPrice.isFinite() || !targetPrice.gt(0)) {
    throw new Error("Shift target price must be finite and positive.");
  }
  if (!Number.isSafeInteger(minimumShift) || minimumShift < 0) {
    throw new Error("Minimum shift must be a non-negative safe integer.");
  }

  const isAboveTarget = (shift: number) =>
    boundaryPrice.times(ratio.pow(shift)).gt(targetPrice);
  if (isAboveTarget(minimumShift)) return minimumShift;

  let lower = minimumShift;
  if (minimumShift > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new Error("Grid shift exceeds the supported safe integer range.");
  }
  let upper = minimumShift === 0 ? 1 : minimumShift * 2;
  while (!isAboveTarget(upper)) {
    lower = upper;
    if (upper > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
      throw new Error("Grid shift exceeds the supported safe integer range.");
    }
    upper *= 2;
  }

  while (lower + 1 < upper) {
    const candidate = lower + Math.floor((upper - lower) / 2);
    if (isAboveTarget(candidate)) {
      upper = candidate;
    } else {
      lower = candidate;
    }
  }
  return upper;
}

export function trailUpTriggerFromBounds(
  lower: Decimal,
  upper: Decimal,
  levelCount: number,
): Decimal | null {
  if (levelCount < 2) return null;
  if (!lower.gt(0) || !upper.gt(0)) return null;
  const ratio = upper.div(lower).pow(new Decimal(1).div(levelCount - 1));
  const trigger = upper.times(ratio.pow(2));
  return trigger.isFinite() ? trigger : null;
}

export function trailUpTriggerPrice(levels: GridLevelState[]): Decimal | null {
  if (levels.length < 2) return null;
  return trailUpTriggerFromBounds(
    new Decimal(levels[0].price),
    new Decimal(levels[levels.length - 1].price),
    levels.length,
  );
}
