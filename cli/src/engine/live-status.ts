import type {
  TelegramConnection,
  StatusMessageRef,
  StatusMessageRefs,
} from "../db/store.js";
import { editWithRetries, pinMessage, sendWithRetries } from "./notify.js";

export type { StatusMessageRef, StatusMessageRefs };

interface ReporterOptions {
  connections: TelegramConnection[];
  refs?: StatusMessageRefs;
  minIntervalMs?: number;
  pin?: boolean;
  parseMode?: string;
}

const DEFAULT_MIN_INTERVAL_MS = 5000;

export class LiveStatusReporter {
  private readonly _connections: TelegramConnection[];
  private readonly _refs: StatusMessageRefs;
  private readonly _minIntervalMs: number;
  private readonly _pin: boolean;
  private readonly _parseMode?: string;
  private readonly _lastText = new Map<string, string>();
  private readonly _pending = new Map<string, string>();
  private readonly _draining = new Map<string, Promise<void>>();
  private readonly _giveUp = new Set<string>();
  private _lastEditMs = 0;

  constructor(opts: ReporterOptions) {
    this._connections = opts.connections;
    this._refs = { ...(opts.refs ?? {}) };
    this._minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this._pin = opts.pin ?? false;
    this._parseMode = opts.parseMode;
  }

  update(text: string): void {
    if (this._connections.length === 0) return;
    for (const conn of this._connections) this._pending.set(conn.id, text);
    const now = Date.now();
    if (now - this._lastEditMs < this._minIntervalMs) return;
    this._lastEditMs = now;
    for (const conn of this._connections) void this._drain(conn);
  }

  async flush(text: string): Promise<void> {
    if (this._connections.length === 0) return;
    this._lastEditMs = Date.now();
    for (const conn of this._connections) this._pending.set(conn.id, text);
    await Promise.allSettled(
      this._connections.map((conn) => this._drain(conn)),
    );
  }

  snapshot(): StatusMessageRefs {
    return { ...this._refs };
  }

  private _drain(conn: TelegramConnection): Promise<void> {
    const existing = this._draining.get(conn.id);
    if (existing) return existing;
    const p = this._runDrain(conn).finally(() => {
      this._draining.delete(conn.id);
    });
    this._draining.set(conn.id, p);
    return p;
  }

  private async _runDrain(conn: TelegramConnection): Promise<void> {
    while (this._pending.has(conn.id)) {
      const text = this._pending.get(conn.id)!;
      this._pending.delete(conn.id);
      if (this._lastText.get(conn.id) === text) continue;
      await this._send(conn, text);
    }
  }

  private async _send(conn: TelegramConnection, text: string): Promise<void> {
    if (this._giveUp.has(conn.id)) return;
    const ref = this._refs[conn.id];
    if (ref) {
      const result = await editWithRetries(
        conn.bot_token,
        ref.chatId,
        ref.messageId,
        text,
        3,
        this._parseMode,
      );
      if (result.success) {
        this._lastText.set(conn.id, text);
        return;
      }
      if (!result.notFound) return;
      delete this._refs[conn.id];
    }
    await this._create(conn, text);
  }

  private async _create(conn: TelegramConnection, text: string): Promise<void> {
    const result = await sendWithRetries(
      conn.bot_token,
      conn.chat_id,
      text,
      3,
      this._parseMode,
    );
    if (!result.success) return;
    if (result.messageId === undefined) {
      this._giveUp.add(conn.id);
      return;
    }
    const ref: StatusMessageRef = {
      messageId: result.messageId,
      chatId: conn.chat_id,
    };
    if (this._pin) {
      const pinned = await pinMessage(
        conn.bot_token,
        conn.chat_id,
        result.messageId,
      );
      ref.pinned = pinned.success;
    }
    this._refs[conn.id] = ref;
    this._lastText.set(conn.id, text);
  }
}
