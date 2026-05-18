import * as readline from "node:readline";
import type { LivePriceSource, PriceTick, ScenarioCandle } from "../types.js";
import { parseContent, parseLineToTick } from "../format/parse.js";

export async function loadStdinCandles(): Promise<ScenarioCandle[]> {
  if (process.stdin.isTTY) {
    throw new Error("--prices stdin: stdin is a TTY (pipe data in instead)");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return parseContent(raw, "stdin");
}

export function stdinLiveSource(): LivePriceSource {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const iter: AsyncIterator<string> = rl[Symbol.asyncIterator]();
  let index = 0;
  let closed = false;
  return {
    async next() {
      while (!closed) {
        const r = await iter.next();
        if (r.done) {
          closed = true;
          rl.close();
          return null;
        }
        const tick = parseLineToTick(r.value, index);
        if (tick) {
          index++;
          return tick as PriceTick;
        }
      }
      return null;
    },
    async close() {
      closed = true;
      rl.close();
    },
  };
}
