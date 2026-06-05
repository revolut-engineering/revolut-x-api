import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  editMessage,
  pinMessage,
  editWithRetries,
  sendWithRetries,
} from "../src/engine/notify.js";

function res(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  };
}

let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

describe("telegram api primitives", () => {
  it("sendWithRetries returns parsed message_id", async () => {
    mockFetch.mockResolvedValue(
      res(200, JSON.stringify({ ok: true, result: { message_id: 42 } })),
    );
    const r = await sendWithRetries("t", "c", "hi");
    expect(r.success).toBe(true);
    expect(r.messageId).toBe(42);
  });

  it("parses message_id from a full (>300 char) Telegram response", async () => {
    const fullBody = JSON.stringify({
      ok: true,
      result: {
        message_id: 777,
        from: { id: 123456789, is_bot: true, username: "grid_status_bot" },
        chat: { id: -1002233445566, title: "Trading", type: "supergroup" },
        date: 1735000000,
        text:
          "🟢 Grid BTC-USD [DRY RUN]\n".repeat(8) +
          "Open orders (6):\n SELL 0.00132374 BTC @ $75,540.31",
      },
    });
    expect(fullBody.length).toBeGreaterThan(300);
    mockFetch.mockResolvedValue(res(200, fullBody));
    const r = await sendWithRetries("t", "c", "card");
    expect(r.success).toBe(true);
    expect(r.messageId).toBe(777);
  });

  it("editMessage succeeds and parses message_id", async () => {
    mockFetch.mockResolvedValue(
      res(200, JSON.stringify({ ok: true, result: { message_id: 9 } })),
    );
    const r = await editMessage("t", "c", 9, "new");
    expect(r.success).toBe(true);
    expect(r.messageId).toBe(9);
    expect(mockFetch.mock.calls[0][0]).toContain("/editMessageText");
  });

  it("editMessage treats 'not modified' as success", async () => {
    mockFetch.mockResolvedValue(
      res(400, "Bad Request: message is not modified"),
    );
    const r = await editMessage("t", "c", 9, "same");
    expect(r.success).toBe(true);
    expect(r.notModified).toBe(true);
  });

  it("editMessage flags 'message to edit not found'", async () => {
    mockFetch.mockResolvedValue(
      res(400, "Bad Request: message to edit not found"),
    );
    const r = await editMessage("t", "c", 9, "x");
    expect(r.success).toBe(false);
    expect(r.notFound).toBe(true);
  });

  it("editMessage extracts retry_after on 429", async () => {
    mockFetch.mockResolvedValue(
      res(429, JSON.stringify({ parameters: { retry_after: 7 } })),
    );
    const r = await editMessage("t", "c", 9, "x");
    expect(r.success).toBe(false);
    expect(r.retryAfter).toBe(7);
  });

  it("editWithRetries does not retry on notFound", async () => {
    mockFetch.mockResolvedValue(
      res(400, "Bad Request: message to edit not found"),
    );
    const r = await editWithRetries("t", "c", 9, "x");
    expect(r.notFound).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("includes parse_mode in the request body when provided", async () => {
    mockFetch.mockResolvedValue(
      res(200, JSON.stringify({ ok: true, result: { message_id: 1 } })),
    );
    await sendWithRetries("t", "c", "x", 3, "MarkdownV2");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.parse_mode).toBe("MarkdownV2");
  });

  it("omits parse_mode by default", async () => {
    mockFetch.mockResolvedValue(
      res(200, JSON.stringify({ ok: true, result: { message_id: 1 } })),
    );
    await sendWithRetries("t", "c", "x");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.parse_mode).toBeUndefined();
  });

  it("pinMessage posts to pinChatMessage", async () => {
    mockFetch.mockResolvedValue(res(200, JSON.stringify({ ok: true })));
    const r = await pinMessage("t", "c", 9);
    expect(r.success).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toContain("/pinChatMessage");
  });
});
