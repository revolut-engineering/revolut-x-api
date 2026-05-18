import { Decimal } from "decimal.js";

export interface ScenarioCandle {
  start: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume?: Decimal;
}

export interface PriceTick {
  price: Decimal;
  timestamp: number;
}

export interface BatchPriceSource {
  loadAll(): Promise<ScenarioCandle[]>;
}

export interface LivePriceSource {
  next(): Promise<PriceTick | null>;
  peek?(): Promise<Decimal>;
  close?(): Promise<void>;
  readonly paceIntervalSec?: number;
}

export type GeneratorType = "linear" | "sine" | "walk" | "steps";

export interface GeneratorParams {
  type: GeneratorType;
  params: Record<string, string>;
}

export type PriceSpec =
  | { kind: "api"; raw: string }
  | { kind: "file"; raw: string; path: string }
  | { kind: "stdin"; raw: string }
  | { kind: "inline"; raw: string; values: number[] }
  | { kind: "gen"; raw: string; gen: GeneratorParams }
  | { kind: "interactive"; raw: string };

export type PriceSpecKind = PriceSpec["kind"];
