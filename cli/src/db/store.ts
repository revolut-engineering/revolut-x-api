import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir, ensureConfigDir } from "revolutx-api";

export interface TelegramConnection {
  id: string;
  label: string;
  bot_token: string;
  chat_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  ts: string;
  category: string;
  details: Record<string, unknown>;
}

function filePath(filename: string): string {
  return join(getConfigDir(), filename);
}

function loadArray<T>(filename: string): T[] {
  const path = filePath(filename);
  if (!existsSync(path)) return [];
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return [];
  }
}

function saveArray<T>(filename: string, data: T[]): void {
  ensureConfigDir();
  const path = filePath(filename);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

const TELEGRAM_FILE = "telegram.json";

export function loadConnections(): TelegramConnection[] {
  return loadArray<TelegramConnection>(TELEGRAM_FILE);
}

export function saveConnections(connections: TelegramConnection[]): void {
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

const EVENTS_FILE = "events.json";
const MAX_EVENTS = 1000;

export function loadEvents(opts?: {
  category?: string;
  limit?: number;
}): Event[] {
  let events = loadArray<Event>(EVENTS_FILE);
  if (opts?.category) {
    events = events.filter((e) => e.category === opts.category);
  }
  if (opts?.limit) {
    events = events.slice(-opts.limit);
  }
  return events;
}

export function appendEvent(
  category: string,
  details: Record<string, unknown>,
): void {
  const events = loadArray<Event>(EVENTS_FILE);
  events.push({
    id: randomUUID(),
    ts: new Date().toISOString(),
    category,
    details,
  });
  while (events.length > MAX_EVENTS) {
    events.shift();
  }
  saveArray(EVENTS_FILE, events);
}
