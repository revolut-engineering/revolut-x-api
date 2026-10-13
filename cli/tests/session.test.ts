import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PassThrough } from "node:stream";
import {
  EMPTY_KEYSTROKES,
  isYes,
  readKeystrokes,
  readTerminalLine,
  type KeystrokeState,
} from "../src/util/session.js";

function type(...chunks: string[]) {
  let state: KeystrokeState = EMPTY_KEYSTROKES;
  for (const chunk of chunks) {
    const { outcome, ...next } = readKeystrokes(state, chunk);
    if (outcome !== "typing") return { ...next, outcome };
    state = next;
  }
  return { ...state, outcome: "typing" as const };
}

describe("readKeystrokes", () => {
  const KEY = "A".repeat(64);

  it.each([
    ["a key pasted with Enter in one chunk", `${KEY}\r`],
    ["a key pasted with a newline in one chunk", `${KEY}\n`],
    ["a key pasted with CRLF in one chunk", `${KEY}\r\n`],
  ])("finishes %s", (_name, chunk) => {
    expect(type(chunk)).toMatchObject({ value: KEY, outcome: "enter" });
  });

  it("keeps typing across chunks until Enter", () => {
    expect(type("AB", "C\r")).toMatchObject({
      value: "ABC",
      outcome: "enter",
    });
  });

  it("applies backspace and delete", () => {
    expect(type("AB\x7fC\x08D\r").value).toBe("AD");
  });

  it("clears the line on Ctrl+U and the last word on Ctrl+W", () => {
    expect(type("ABC\x15D\r").value).toBe("D");
    expect(type("AB CD \x17\r").value).toBe("AB ");
  });

  it("ignores arrow keys and bracketed-paste markers", () => {
    expect(type("\x1b[A\x1b[200~KEY\x1b[201~\x1bOB\r").value).toBe("KEY");
  });

  it.each([
    ["after the escape", ["\x1b", "[A", "KEY\r"]],
    ["inside the parameters", ["KEY\x1b[20", "1~\r"]],
    ["after the bracket", ["K\x1b[", "AEY\r"]],
  ])("drops an escape sequence split %s", (_name, chunks) => {
    expect(type(...chunks).value).toBe("KEY");
  });

  it("keeps a key typed after a lone Escape in a later read", () => {
    expect(type("K", "\x1b", "EY\r").value).toBe("KEY");
  });

  it("drops an Alt key and a doubled escape", () => {
    expect(type("K\x1bxEY\x1b\x1b[D\r").value).toBe("KEY");
  });

  it("still cancels on Ctrl+C right after Escape", () => {
    expect(type("KEY\x1b\x03").outcome).toBe("cancel");
  });

  it("treats Option+Backspace as a backspace", () => {
    expect(type("KEYS\x1b\x7f\r").value).toBe("KEY");
  });

  it("ignores other control characters", () => {
    expect(type("K\x00E\x07Y\r").value).toBe("KEY");
  });

  it("cancels on Ctrl+C", () => {
    expect(type("KEY\x03")).toMatchObject({ value: "KEY", outcome: "cancel" });
  });

  it("keeps characters outside ASCII, even split across reads", () => {
    const decoder = new StringDecoder("utf8");
    const bytes = Buffer.from("ключ€\r");
    const chunks = [bytes.subarray(0, 3), bytes.subarray(3)].map((part) =>
      decoder.write(part),
    );

    expect(type(...chunks).value).toBe("ключ€");
  });

  it("removes a whole character on backspace", () => {
    expect(type("A😀\x7f\r").value).toBe("A");
  });

  it("swallows the newline of a CRLF that arrives in the next read", () => {
    // given
    const first = type("KEY\r");

    // when
    const second = readKeystrokes(
      { ...EMPTY_KEYSTROKES, skipLineFeed: first.skipLineFeed },
      "\nNEXT\r",
    );

    // then
    expect(first.skipLineFeed).toBe(true);
    expect(second).toMatchObject({ value: "NEXT", outcome: "enter" });
  });

  it("keeps a newline that does not follow Enter", () => {
    expect(readKeystrokes(EMPTY_KEYSTROKES, "\nNEXT\r")).toMatchObject({
      value: "",
      outcome: "enter",
    });
  });
});

describe("promptHiddenInput with piped input", () => {
  function runPrompts(input: string, keepOpenMs = 0) {
    const dir = mkdtempSync(join(tmpdir(), "revx-prompt-"));
    const script = join(dir, "prompts.mts");
    writeFileSync(
      script,
      `import { promptHiddenInput, confirm } from ${JSON.stringify(resolve("src/util/session.ts"))};
const first = await promptHiddenInput("");
const second = await confirm("");
const third = await promptHiddenInput("");
const fourth = await promptHiddenInput("");
process.stderr.write(JSON.stringify([first, second, third, fourth]));
`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", script]);
    child.stdin.write(input);
    const closeLater = setTimeout(() => child.stdin.end(), keepOpenMs);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const startedAt = Date.now();
    return new Promise<{ answers: unknown; ms: number }>((done, fail) => {
      child.on("exit", () => {
        clearTimeout(closeLater);
        rmSync(dir, { recursive: true, force: true });
        try {
          done({ answers: JSON.parse(stderr), ms: Date.now() - startedAt });
        } catch {
          fail(new Error(stderr));
        }
      });
    });
  }

  it("reads every line of input, not only the first", async () => {
    const { answers } = await runPrompts("bad\ny\nGOOD\n");

    expect(answers).toEqual(["bad", true, "GOOD", null]);
  }, 20_000);

  it("finishes once its lines are read, even while the input stays open", async () => {
    const { answers, ms } = await runPrompts("a\nn\nb\nc\n", 10_000);

    expect(answers).toEqual(["a", false, "b", "c"]);
    expect(ms).toBeLessThan(9_000);
  }, 20_000);
});

describe("readTerminalLine", () => {
  it("returns the typed line, not the close that follows it", async () => {
    // given
    const input = new PassThrough();
    const answer = readTerminalLine(input);

    // when
    input.write("y\n");

    // then
    await expect(answer).resolves.toBe("y");
  });

  it("returns null when the input ends without a line", async () => {
    // given
    const input = new PassThrough();
    const answer = readTerminalLine(input);

    // when
    input.end();

    // then
    await expect(answer).resolves.toBeNull();
  });

  it.each([
    ["y", true],
    [" YES ", true],
    ["n", false],
    ["", false],
    [null, false],
  ])("reads %j as yes: %s", (answer, expected) => {
    expect(isYes(answer)).toBe(expected);
  });
});
