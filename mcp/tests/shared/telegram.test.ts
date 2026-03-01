import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";

import {
  sendMessage,
  redactToken,
} from "../../src/shared/notify/telegram.js";

const API_BASE = "https://api.telegram.org";
const TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ";
const CHAT_ID = "987654321";

describe("sendMessage", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("success 200", async () => {
    nock(API_BASE)
      .post(`/bot${TOKEN}/sendMessage`)
      .reply(200, { ok: true });

    const result = await sendMessage(TOKEN, CHAT_ID, "Hello");
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("error 400", async () => {
    nock(API_BASE)
      .post(`/bot${TOKEN}/sendMessage`)
      .reply(400, "Bad Request: chat not found");

    const result = await sendMessage(TOKEN, CHAT_ID, "Hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
    expect(result.error).toContain("Bad Request");
  });

  it("server error 500", async () => {
    nock(API_BASE)
      .post(`/bot${TOKEN}/sendMessage`)
      .reply(500, "Internal Server Error");

    const result = await sendMessage(TOKEN, CHAT_ID, "Hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("network error", async () => {
    nock(API_BASE)
      .post(`/bot${TOKEN}/sendMessage`)
      .replyWithError("connection refused");

    const result = await sendMessage(TOKEN, CHAT_ID, "Hello");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("error body truncated to 200 chars", async () => {
    const longBody = "x".repeat(500);
    nock(API_BASE)
      .post(`/bot${TOKEN}/sendMessage`)
      .reply(400, longBody);

    const result = await sendMessage(TOKEN, CHAT_ID, "Hello");
    expect(result.success).toBe(false);
    // error contains "HTTP 400: " (10 chars) + up to 200 chars of body
    expect(result.error!.length).toBeLessThanOrEqual(210);
  });
});

describe("redactToken", () => {
  it("long token shows last 4 chars", () => {
    const token = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ";
    const redacted = redactToken(token);
    expect(redacted).toBe(`****${token.slice(-4)}`);
  });

  it("short token returns ****", () => {
    expect(redactToken("abc")).toBe("****");
    expect(redactToken("abcd")).toBe("****");
  });

  it("empty string returns ****", () => {
    expect(redactToken("")).toBe("****");
  });
});
