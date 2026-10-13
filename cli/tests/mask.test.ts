import { describe, expect, it } from "vitest";
import { maskSecret } from "../src/util/mask.js";

describe("maskSecret", () => {
  it.each([
    ["a 64-character API key", `abcd${"x".repeat(56)}wxyz`, "abcd****wxyz"],
    ["a Telegram bot token", "123456789:AAH-token-tail", "1234****tail"],
    ["anything too short to show safely", "abcdefghij", "****"],
    ["an empty value", "", "****"],
  ])("masks %s", (_, secret, masked) => {
    expect(maskSecret(secret)).toBe(masked);
  });
});
