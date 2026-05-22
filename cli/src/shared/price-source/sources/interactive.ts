import * as readline from "node:readline";
import { Decimal } from "decimal.js";
import type { LivePriceSource, PriceTick } from "../types.js";

export interface InteractiveOptions {
  prompt?: () => string;
  output?: NodeJS.WritableStream;
}

export function interactiveLiveSource(
  opts: InteractiveOptions = {},
): LivePriceSource {
  const out = opts.output ?? process.stdout;
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const iter = rl[Symbol.asyncIterator]();
  let closed = false;
  let index = 0;

  return {
    async next(): Promise<PriceTick | null> {
      while (!closed) {
        const promptStr = opts.prompt
          ? opts.prompt()
          : `[tick ${index}] next price (or 'q' to quit)> `;
        if (process.stdin.isTTY) {
          out.write(promptStr);
        }
        const r = await iter.next();
        if (r.done) {
          closed = true;
          return null;
        }
        const answer = r.value as string;
        const trimmed = answer.trim();
        if (!trimmed) continue;
        if (trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
          closed = true;
          rl.close();
          return null;
        }
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n <= 0) {
          out.write(`  invalid price '${trimmed}', try again\n`);
          continue;
        }
        const tick: PriceTick = {
          price: new Decimal(trimmed),
          timestamp: Date.now(),
        };
        index++;
        return tick;
      }
      return null;
    },
    async close() {
      closed = true;
      rl.close();
    },
  };
}
