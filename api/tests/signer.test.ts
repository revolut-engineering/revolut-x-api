import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { signRequest, buildAuthHeaders } from "../src/auth/signer.js";

function makeTestKey() {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return createPrivateKey(privateKey);
}

describe("signRequest", () => {
  const key = makeTestKey();

  it("produces base64 signature", () => {
    const sig = signRequest(key, "1700000000000", "GET", "/api/1.0/balances");
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("includes all parts in message", () => {
    const sig1 = signRequest(
      key,
      "1700000000000",
      "GET",
      "/api/1.0/balances",
      "",
      "",
    );
    const sig2 = signRequest(
      key,
      "1700000000000",
      "GET",
      "/api/1.0/balances",
      "limit=10",
      "",
    );
    expect(sig1).not.toBe(sig2);
  });

  it("body affects signature", () => {
    const sig1 = signRequest(
      key,
      "1700000000000",
      "POST",
      "/api/1.0/orders",
      "",
      "",
    );
    const sig2 = signRequest(
      key,
      "1700000000000",
      "POST",
      "/api/1.0/orders",
      "",
      '{"symbol":"BTC-USD"}',
    );
    expect(sig1).not.toBe(sig2);
  });

  it("method is uppercased", () => {
    const sig1 = signRequest(key, "1700000000000", "get", "/api/1.0/balances");
    const sig2 = signRequest(key, "1700000000000", "GET", "/api/1.0/balances");
    expect(sig1).toBe(sig2);
  });

  it("deterministic for same inputs", () => {
    const sig1 = signRequest(key, "1700000000000", "GET", "/api/1.0/balances");
    const sig2 = signRequest(key, "1700000000000", "GET", "/api/1.0/balances");
    expect(sig1).toBe(sig2);
  });
});

describe("buildAuthHeaders", () => {
  const key = makeTestKey();

  it("returns all three required headers", () => {
    const headers = buildAuthHeaders(
      "test-api-key",
      key,
      "GET",
      "/api/1.0/balances",
    );
    expect(headers["X-Revx-API-Key"]).toBe("test-api-key");
    expect(headers["X-Revx-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["X-Revx-Signature"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("timestamp is current epoch ms", () => {
    const before = Date.now();
    const headers = buildAuthHeaders("key", key, "GET", "/api/1.0/balances");
    const after = Date.now();
    const ts = Number(headers["X-Revx-Timestamp"]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
