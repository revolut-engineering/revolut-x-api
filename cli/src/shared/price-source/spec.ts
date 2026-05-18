import type { GeneratorType, PriceSpec } from "./types.js";

const GEN_TYPES = new Set<GeneratorType>(["linear", "sine", "walk", "steps"]);

function isGeneratorType(s: string): s is GeneratorType {
  return (GEN_TYPES as Set<string>).has(s);
}

export class PriceSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceSpecError";
  }
}

export function parseSpec(raw: string | undefined): PriceSpec {
  const s = (raw ?? "api").trim();
  if (s === "" || s === "api") {
    return { kind: "api", raw: "api" };
  }
  if (s === "stdin" || s === "-") {
    return { kind: "stdin", raw: s };
  }
  if (s === "interactive") {
    return { kind: "interactive", raw: s };
  }

  if (s.startsWith("file:")) {
    const path = s.slice(5).trim();
    if (!path) throw new PriceSpecError("--prices file: requires a path");
    return { kind: "file", raw: s, path };
  }

  if (s.startsWith("inline:")) {
    const csv = s.slice(7).trim();
    if (!csv)
      throw new PriceSpecError(
        "--prices inline: requires comma-separated values",
      );
    const values: number[] = [];
    for (const part of csv.split(",")) {
      const tok = part.trim();
      if (!tok) continue;
      const n = Number(tok);
      if (!Number.isFinite(n) || n <= 0) {
        throw new PriceSpecError(
          `--prices inline: invalid value '${tok}' (must be positive number)`,
        );
      }
      values.push(n);
    }
    if (values.length === 0) {
      throw new PriceSpecError("--prices inline: requires at least one value");
    }
    return { kind: "inline", raw: s, values };
  }

  if (s.startsWith("gen:")) {
    const rest = s.slice(4);
    const qIdx = rest.indexOf("?");
    const type = (qIdx === -1 ? rest : rest.slice(0, qIdx)).trim();
    if (!isGeneratorType(type)) {
      throw new PriceSpecError(
        `--prices gen: unknown generator '${type}'. Supported: ${[...GEN_TYPES].sort().join(", ")}`,
      );
    }
    const params: Record<string, string> = {};
    if (qIdx !== -1) {
      const qs = rest.slice(qIdx + 1);
      for (const part of qs.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        if (eq === -1) {
          params[decodeURIComponent(part)] = "";
        } else {
          params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(
            part.slice(eq + 1),
          );
        }
      }
    }
    return { kind: "gen", raw: s, gen: { type, params } };
  }

  throw new PriceSpecError(
    `--prices: unrecognized spec '${s}'. Expected one of: api, file:<path>, stdin, inline:<csv>, gen:<type>?<params>, interactive`,
  );
}

export function requireGenNumber(
  params: Record<string, string>,
  key: string,
  fallback?: number,
): number {
  const v = params[key];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new PriceSpecError(`gen: missing parameter '${key}'`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new PriceSpecError(
      `gen: parameter '${key}' must be a number, got '${v}'`,
    );
  }
  return n;
}

export function requireGenInt(
  params: Record<string, string>,
  key: string,
  fallback?: number,
): number {
  const n = requireGenNumber(params, key, fallback);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PriceSpecError(
      `gen: parameter '${key}' must be a positive integer`,
    );
  }
  return n;
}
