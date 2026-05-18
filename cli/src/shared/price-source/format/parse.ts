import type { ScenarioCandle } from "../types.js";
import { ParseError } from "./common.js";
import { parseCsv } from "./csv.js";
import { parseJson } from "./json.js";
import { parseNdjson } from "./ndjson.js";

export { ParseError } from "./common.js";
export { parseLineToTick } from "./ndjson.js";

export function parseContent(
  raw: string,
  sourceLabel = "input",
): ScenarioCandle[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ParseError(`${sourceLabel}: empty input`);
  }
  if (trimmed.startsWith("[")) {
    return parseJson(trimmed, sourceLabel);
  }
  if (trimmed.startsWith("{")) {
    return parseNdjson(trimmed, sourceLabel);
  }
  return parseCsv(trimmed, sourceLabel);
}
