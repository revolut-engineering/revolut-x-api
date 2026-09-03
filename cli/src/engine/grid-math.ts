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

export function trailUpTriggerFromBounds(
  lower: Decimal,
  upper: Decimal,
  levelCount: number,
): Decimal | null {
  if (levelCount < 2) return null;
  if (!lower.gt(0) || !upper.gt(0)) return null;
  const ratio = upper.div(lower).pow(new Decimal(1).div(levelCount - 1));
  const trigger = upper
    .times(ratio)
    .plus(upper.times(ratio.pow(2)))
    .div(2);
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
