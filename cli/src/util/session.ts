import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { getPasskeyFileHash, hasPasskey, verifyPasskey } from "./passkey.js";

const SESSION_DIR = join(tmpdir(), "revx_sessions");

let _sessionId: string | undefined;

function getShellSessionKey(shellPid: number): string {
  // Prefer ps start time — uniquely identifies a shell across PID reuse
  try {
    const startTime = execSync(`ps -p ${shellPid} -o lstart=`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (startTime) return `${shellPid}:${startTime}`;
  } catch {
    // ps unavailable — try terminal session env vars
  }
  // Fallback: terminal session IDs set by common emulators (Terminal.app, iTerm2, tmux)
  const termSession =
    process.env.TERM_SESSION_ID ??
    process.env.ITERM_SESSION_ID ??
    process.env.TMUX ??
    process.env.STY;
  if (termSession) return `${shellPid}:${termSession}`;
  // Last resort: PID only (accepts PID reuse risk on ps-less environments)
  return `${shellPid}:unknown`;
}

function getSessionId(): string {
  if (_sessionId) return _sessionId;
  _sessionId = createHash("sha256")
    .update(getShellSessionKey(process.ppid))
    .digest("hex");
  return _sessionId;
}

function computeToken(passkeyHash: string, sessionId: string): string {
  return createHmac("sha256", passkeyHash).update(sessionId).digest("hex");
}

function isSessionUnlocked(): boolean {
  const sessionId = getSessionId();
  const sessionFile = join(SESSION_DIR, sessionId);
  if (!existsSync(sessionFile)) return false;
  try {
    const data = JSON.parse(readFileSync(sessionFile, "utf-8")) as {
      token?: unknown;
    };
    if (typeof data.token !== "string") return false;
    const expected = computeToken(getPasskeyFileHash(), sessionId);
    const tokenBuf = Buffer.from(data.token, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (tokenBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(tokenBuf, expectedBuf);
  } catch {
    return false;
  }
}

function writeSessionToken(): void {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  const sessionId = getSessionId();
  const token = computeToken(getPasskeyFileHash(), sessionId);
  writeFileSync(join(SESSION_DIR, sessionId), JSON.stringify({ token }), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

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

export async function requireSessionAuth(): Promise<void> {
  if (!hasPasskey()) return;

  if (isSessionUnlocked()) return;

  const passkey = await promptHiddenInput("Passkey: ");

  if (!verifyPasskey(passkey)) {
    console.error("Error: Incorrect passkey.");
    process.exit(1);
  }

  writeSessionToken();
}
