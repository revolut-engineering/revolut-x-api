import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.fn();
const mockEdit = vi.fn();
const mockPin = vi.fn();
vi.mock("../src/engine/notify.js", () => ({
  sendWithRetries: (...a: unknown[]) => mockSend(...a),
  editWithRetries: (...a: unknown[]) => mockEdit(...a),
  pinMessage: (...a: unknown[]) => mockPin(...a),
}));

const { LiveStatusReporter } = await import("../src/engine/live-status.js");
type Conn = import("../src/db/store.js").TelegramConnection;

function conn(id: string, chat = `chat-${id}`): Conn {
  return {
    id,
    label: id,
    bot_token: `token-${id}`,
    chat_id: chat,
    enabled: true,
    created_at: "",
    updated_at: "",
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ success: true, messageId: 100 });
  mockEdit.mockResolvedValue({ success: true });
  mockPin.mockResolvedValue({ success: true });
});

describe("LiveStatusReporter", () => {
  it("creates and stores a message ref on first push", async () => {
    const c = conn("a");
    const r = new LiveStatusReporter({ connections: [c] });
    await r.flush("hello");
    expect(mockSend).toHaveBeenCalledWith(
      c.bot_token,
      c.chat_id,
      "hello",
      3,
      undefined,
    );
    expect(r.snapshot()[c.id]).toEqual({ messageId: 100, chatId: c.chat_id });
  });

  it("edits the existing message when a ref is hydrated", async () => {
    const c = conn("a");
    const r = new LiveStatusReporter({
      connections: [c],
      refs: { [c.id]: { messageId: 55, chatId: c.chat_id } },
    });
    await r.flush("updated");
    expect(mockEdit).toHaveBeenCalledWith(
      c.bot_token,
      c.chat_id,
      55,
      "updated",
      3,
      undefined,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("skips identical content", async () => {
    const c = conn("a");
    const r = new LiveStatusReporter({
      connections: [c],
      refs: { [c.id]: { messageId: 55, chatId: c.chat_id } },
    });
    await r.flush("same");
    await r.flush("same");
    expect(mockEdit).toHaveBeenCalledTimes(1);
  });

  it("re-sends when the edited message is gone", async () => {
    const c = conn("a");
    mockEdit.mockResolvedValue({ success: false, notFound: true });
    mockSend.mockResolvedValue({ success: true, messageId: 999 });
    const r = new LiveStatusReporter({
      connections: [c],
      refs: { [c.id]: { messageId: 55, chatId: c.chat_id } },
    });
    await r.flush("y");
    expect(mockEdit).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(r.snapshot()[c.id].messageId).toBe(999);
  });

  it("coalesces queued updates to the latest while a send is in flight", async () => {
    const c = conn("a");
    let resolve1!: () => void;
    mockEdit
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolve1 = () => res({ success: true });
          }),
      )
      .mockResolvedValue({ success: true });
    const r = new LiveStatusReporter({
      connections: [c],
      refs: { [c.id]: { messageId: 1, chatId: c.chat_id } },
      minIntervalMs: 0,
    });
    r.update("v1");
    r.update("v2");
    r.update("v3");
    await tick();
    resolve1();
    await tick();
    expect(mockEdit).toHaveBeenCalledTimes(2);
    expect(mockEdit).toHaveBeenNthCalledWith(
      1,
      c.bot_token,
      c.chat_id,
      1,
      "v1",
      3,
      undefined,
    );
    expect(mockEdit).toHaveBeenNthCalledWith(
      2,
      c.bot_token,
      c.chat_id,
      1,
      "v3",
      3,
      undefined,
    );
  });

  it("flush sends the final card even when an update edit is in flight", async () => {
    const c = conn("a");
    let resolveRunning!: () => void;
    mockEdit
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveRunning = () => res({ success: true });
          }),
      )
      .mockResolvedValue({ success: true });
    const r = new LiveStatusReporter({
      connections: [c],
      refs: { [c.id]: { messageId: 1, chatId: c.chat_id } },
    });
    r.update("running");
    const flushed = r.flush("FINISHED");
    await tick();
    resolveRunning();
    await flushed;
    expect(mockEdit).toHaveBeenCalledWith(
      c.bot_token,
      c.chat_id,
      1,
      "FINISHED",
      3,
      undefined,
    );
  });

  it("pins the created message when pin is enabled", async () => {
    const c = conn("a");
    mockSend.mockResolvedValue({ success: true, messageId: 7 });
    const r = new LiveStatusReporter({ connections: [c], pin: true });
    await r.flush("p");
    expect(mockPin).toHaveBeenCalledWith(c.bot_token, c.chat_id, 7);
    expect(r.snapshot()[c.id].pinned).toBe(true);
  });

  it("tracks an independent message ref per connection", async () => {
    const a = conn("a");
    const b = conn("b");
    mockSend
      .mockResolvedValueOnce({ success: true, messageId: 101 })
      .mockResolvedValueOnce({ success: true, messageId: 102 });
    const r = new LiveStatusReporter({ connections: [a, b] });
    await r.flush("hi");
    expect(mockSend).toHaveBeenCalledTimes(2);
    const snap = r.snapshot();
    expect(snap[a.id]).toEqual({ messageId: 101, chatId: a.chat_id });
    expect(snap[b.id]).toEqual({ messageId: 102, chatId: b.chat_id });
  });

  it("does nothing without connections", async () => {
    const r = new LiveStatusReporter({ connections: [] });
    await r.flush("x");
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.snapshot()).toEqual({});
  });

  it("does not re-create when a send succeeds without a message id", async () => {
    const c = conn("a");
    mockSend.mockResolvedValue({ success: true, messageId: undefined });
    const r = new LiveStatusReporter({ connections: [c] });
    await r.flush("v1");
    await r.flush("v2");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(r.snapshot()).toEqual({});
  });
});
