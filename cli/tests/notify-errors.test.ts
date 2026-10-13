import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "../src/engine/notify.js";

describe("Telegram error text", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Telegram's own description of the problem", async () => {
    // given
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: chat not found",
            }),
            { status: 400 },
          ),
      ),
    );

    // when
    const result = await sendMessage("123:abc", "42", "hello");

    // then
    expect(result).toMatchObject({
      success: false,
      error: "HTTP 400: Bad Request: chat not found",
    });
  });

  it("keeps the body when Telegram sends no description", async () => {
    // given
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      ),
    );

    // when
    const result = await sendMessage("123:abc", "42", "hello");

    // then
    expect(result.error).toBe("HTTP 502: <html>Bad Gateway</html>");
  });

  it("names the network failure behind fetch failed", async () => {
    // given
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          }),
        });
      }),
    );

    // when
    const result = await sendMessage("123:abc", "42", "hello");

    // then
    expect(result.error).toBe("fetch failed (ECONNREFUSED)");
  });
});
