import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~]|[ -~])?/g;
// eslint-disable-next-line no-control-regex
const INCOMPLETE_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|O)?$/;

export interface KeystrokeState {
  value: string;
  pending: string;
  skipLineFeed: boolean;
}

export interface KeystrokeResult extends KeystrokeState {
  outcome: "typing" | "enter" | "cancel";
}

export const EMPTY_KEYSTROKES: KeystrokeState = {
  value: "",
  pending: "",
  skipLineFeed: false,
};

function joinPending(pending: string, chunk: string): string {
  const loneEscape =
    pending === "\x1b" && !chunk.startsWith("[") && !chunk.startsWith("O");
  return loneEscape ? chunk : pending + chunk;
}

export function readKeystrokes(
  state: KeystrokeState,
  chunk: string,
): KeystrokeResult {
  if (chunk === "") return { ...state, outcome: "typing" };
  let text = joinPending(
    state.pending,
    state.skipLineFeed && chunk.startsWith("\n") ? chunk.slice(1) : chunk,
  );
  let pending = "";
  const tail = INCOMPLETE_ESCAPE.exec(text);
  if (tail) {
    pending = tail[0];
    text = text.slice(0, tail.index);
  }
  const chars = Array.from(text.replace(ESCAPE_SEQUENCE, ""));
  let value = state.value;
  for (const [index, char] of chars.entries()) {
    if (char === "\r" || char === "\n") {
      return {
        value,
        pending: "",
        skipLineFeed:
          char === "\r" && index === chars.length - 1 && pending === "",
        outcome: "enter",
      };
    }
    if (char === "\x03") {
      return { value, pending: "", skipLineFeed: false, outcome: "cancel" };
    }
    if (char === "\x7f" || char === "\b") {
      value = Array.from(value).slice(0, -1).join("");
    } else if (char === "\x15") {
      value = "";
    } else if (char === "\x17") {
      value = value.replace(/\s+$/, "").replace(/\S+$/, "");
    } else if (char >= " ") {
      value += char;
    }
  }
  return { value, pending, skipLineFeed: false, outcome: "typing" };
}

interface LineReader {
  next(): Promise<string | null>;
}

let pipedLines: LineReader | undefined;
let skipLineFeed = false;

function holdInput(hold: boolean): void {
  const input = process.stdin as { ref?: () => void; unref?: () => void };
  if (hold) input.ref?.();
  else input.unref?.();
}

function readPipedLines(): LineReader {
  const rl = createInterface({ input: process.stdin });
  const pause = (): void => {
    rl.pause();
    holdInput(false);
  };
  const queued: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else queued.push(line);
    if (waiting.length === 0) pause();
  });
  rl.on("close", () => {
    ended = true;
    for (const waiter of waiting.splice(0)) waiter(null);
  });
  pause();
  return {
    next() {
      const line = queued.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiting.push(resolve);
        holdInput(true);
        rl.resume();
      });
    },
  };
}

async function nextPipedLine(): Promise<string | null> {
  pipedLines ??= readPipedLines();
  const line = await pipedLines.next();
  process.stdout.write("\n");
  return line;
}

export function readTerminalLine(
  input: NodeJS.ReadableStream,
): Promise<string | null> {
  const rl = createInterface({ input, terminal: false });
  return new Promise((resolve) => {
    rl.once("line", (line) => {
      resolve(line);
      rl.close();
    });
    rl.once("close", () => resolve(null));
  });
}

async function promptLine(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) return nextPipedLine();
  return readTerminalLine(process.stdin);
}

export function isYes(answer: string | null): boolean {
  return /^\s*y(es)?\s*$/i.test(answer ?? "");
}

export async function confirm(question: string): Promise<boolean> {
  return isYes(await promptLine(`${question} [y/N] `));
}

export async function promptHiddenInput(
  prompt: string,
): Promise<string | null> {
  process.stdout.write(prompt);

  if (!process.stdin.isTTY) return nextPipedLine();

  return new Promise<string>((resolve) => {
    let state: KeystrokeState = { ...EMPTY_KEYSTROKES, skipLineFeed };
    const decoder = new StringDecoder("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", handler);
      process.stdin.pause();
      process.stdout.write("\n");
    };

    const handler = (chunk: Buffer): void => {
      const { outcome, ...next } = readKeystrokes(state, decoder.write(chunk));
      state = next;
      if (outcome === "enter") {
        skipLineFeed = next.skipLineFeed;
        finish();
        resolve(next.value);
      } else if (outcome === "cancel") {
        finish();
        process.exit(1);
      }
    };

    process.stdin.on("data", handler);
  });
}
