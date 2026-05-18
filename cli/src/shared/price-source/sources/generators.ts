import { Decimal } from "decimal.js";
import { PriceSpecError, requireGenInt, requireGenNumber } from "../spec.js";
import type { GeneratorType, ScenarioCandle } from "../types.js";
import { degenerateCandle, tickTimestamp } from "../internal/candles.js";
import { mulberry32, normalSample } from "../internal/random.js";

export function generatePrices(
  type: GeneratorType,
  params: Record<string, string>,
): number[] {
  switch (type) {
    case "linear":
      return genLinear(params);
    case "sine":
      return genSine(params);
    case "walk":
      return genWalk(params);
    case "steps":
      return genSteps(params);
  }
}

export function generatorCandles(
  type: GeneratorType,
  params: Record<string, string>,
): ScenarioCandle[] {
  const prices = generatePrices(type, params);
  const t0 = Date.now();
  return prices.map((p, i) =>
    degenerateCandle(new Decimal(p), tickTimestamp(t0, i)),
  );
}

function genLinear(params: Record<string, string>): number[] {
  const start = requireGenNumber(params, "start");
  const end = requireGenNumber(params, "end");
  const steps = requireGenInt(params, "steps");
  if (steps < 2) {
    throw new PriceSpecError("gen:linear requires steps >= 2");
  }
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    out.push(start + (end - start) * t);
  }
  return out;
}

function genSine(params: Record<string, string>): number[] {
  const start = requireGenNumber(params, "start");
  const amp = requireGenNumber(params, "amp");
  const period = requireGenNumber(params, "period", 24);
  const steps = requireGenInt(params, "steps");
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(start + amp * Math.sin((2 * Math.PI * i) / period));
  }
  return out;
}

function genWalk(params: Record<string, string>): number[] {
  const start = requireGenNumber(params, "start");
  const sigma = requireGenNumber(params, "sigma", 1);
  const steps = requireGenInt(params, "steps");
  const seed = requireGenInt(params, "seed", 1);
  if (sigma < 0) {
    throw new PriceSpecError("gen:walk sigma must be >= 0");
  }
  const rng = mulberry32(seed);
  const out: number[] = [start];
  for (let i = 1; i < steps; i++) {
    const next = out[out.length - 1] + normalSample(rng) * sigma;
    out.push(Math.max(next, 1e-8));
  }
  return out;
}

function genSteps(params: Record<string, string>): number[] {
  const valuesRaw = params["values"] ?? "";
  if (!valuesRaw) {
    throw new PriceSpecError("gen:steps requires values=v1,v2,...");
  }
  const hold = requireGenInt(params, "hold", 1);
  const out: number[] = [];
  for (const tok of valuesRaw.split(",")) {
    const t = tok.trim();
    if (!t) continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) {
      throw new PriceSpecError(`gen:steps invalid value '${t}'`);
    }
    for (let i = 0; i < hold; i++) out.push(n);
  }
  if (out.length === 0) {
    throw new PriceSpecError("gen:steps produced no values");
  }
  return out;
}
