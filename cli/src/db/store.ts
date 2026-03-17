import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir, ensureConfigDir } from "revolutx-api";

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
