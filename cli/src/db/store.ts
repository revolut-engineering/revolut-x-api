import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import {
  getConfigDir,
  ensureConfigDir,
  isMissing,
  redactHome,
  setPermissions,
  writeFileAtomic,
} from "@revolut/revolut-x-api";

export interface TelegramConnection {
  id: string;
  label: string;
  bot_token: string;
  chat_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface StatusMessageRef {
  messageId: number;
  chatId: string;
  pinned?: boolean;
}

export type StatusMessageRefs = Record<string, StatusMessageRef>;

function filePath(filename: string): string {
  return join(getConfigDir(), filename);
}

function healPermissions(path: string): void {
  if (platform() === "win32") return;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return;
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      setPermissions(path, 0o600);
    }
  } catch {}
}

function loadArray<T>(filename: string): T[] {
  const path = filePath(filename);
  if (isMissing(path)) return [];
  healPermissions(path);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(
      code === "EISDIR"
        ? `${redactHome(path)} is a folder, not a file. Move it aside.`
        : `${redactHome(path)} can't be read (${code}). Make sure the file and its folder belong to you and you can read them.`,
      { cause: err },
    );
  }
  const json = text.replace(/^\uFEFF/, "");
  if (json.trim() === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    data = null;
  }
  if (!Array.isArray(data)) {
    throw new Error(
      `${redactHome(path)} is damaged, it is not a JSON list. Fix it or move it aside, then add the connections again.`,
    );
  }
  return data as T[];
}

function saveArray<T>(filename: string, data: T[]): void {
  ensureConfigDir();
  writeFileAtomic(filePath(filename), JSON.stringify(data, null, 2));
}

const TELEGRAM_FILE = "telegram.json";

export function loadConnections(): TelegramConnection[] {
  return loadArray<TelegramConnection>(TELEGRAM_FILE);
}

function saveConnections(connections: TelegramConnection[]): void {
  saveArray(TELEGRAM_FILE, connections);
}

export function createConnection(
  bot_token: string,
  chat_id: string,
  label: string,
): TelegramConnection {
  const connections = loadConnections();
  const now = new Date().toISOString();
  const conn: TelegramConnection = {
    id: randomUUID(),
    label,
    bot_token,
    chat_id,
    enabled: true,
    created_at: now,
    updated_at: now,
  };
  connections.push(conn);
  saveConnections(connections);
  return conn;
}

export function getConnection(id: string): TelegramConnection | undefined {
  return loadConnections().find((c) => c.id === id);
}

export function updateConnection(
  id: string,
  updates: Partial<Pick<TelegramConnection, "enabled" | "label">>,
): TelegramConnection | undefined {
  const connections = loadConnections();
  const idx = connections.findIndex((c) => c.id === id);
  if (idx === -1) return undefined;
  connections[idx] = {
    ...connections[idx],
    ...updates,
    updated_at: new Date().toISOString(),
  };
  saveConnections(connections);
  return connections[idx];
}

export function deleteConnection(id: string): boolean {
  const connections = loadConnections();
  const idx = connections.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  connections.splice(idx, 1);
  saveConnections(connections);
  return true;
}
