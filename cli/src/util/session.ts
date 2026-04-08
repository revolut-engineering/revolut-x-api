import { createInterface } from "node:readline";

function isAllPrintable(buf: Buffer): boolean {
  for (const byte of buf) {
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return true;
}

export async function promptHiddenInput(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  if (!process.stdin.isTTY) {
    // Non-interactive: accumulate chunks until newline via readline
    return new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        rl.close();
        resolve(line);
      });
      process.stdin.resume();
    });
  }

  return new Promise<string>((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const handler = (chunk: Buffer): void => {
      if (chunk[0] === 0x0d || chunk[0] === 0x0a) {
        // Enter
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", handler);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(value);
      } else if (chunk[0] === 0x03) {
        // Ctrl+C
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", handler);
        process.stdin.pause();
        process.stdout.write("\n");
        process.exit(1);
      } else if (chunk[0] === 0x7f || chunk[0] === 0x08) {
        // Backspace / DEL
        if (value.length > 0) value = value.slice(0, -1);
      } else if (isAllPrintable(chunk)) {
        // Accept only chunks where every byte is printable — this correctly
        // allows multi-byte UTF-8 sequences (all bytes ≥ 0x80) while
        // rejecting escape sequences and pasted ANSI codes.
        value += chunk.toString("utf-8");
      }
    };

    process.stdin.on("data", handler);
  });
}
