import { describe, it, expect } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { signRequest, buildAuthHeaders } from "../../src/shared/auth/signer.js";

describe("signer", () => {
  let privateKey: KeyObject;

  beforeAll(() => {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
  });

  it("signRequest returns valid base64", () => {
    const signature = signRequest(
      privateKey,
      "1700000000000",
      "GET",
      "/api/1.0/balances",
    );
    const decoded = Buffer.from(signature, "base64");
    expect(decoded.length).toBe(64); // Ed25519 signatures are 64 bytes
  });

  it("signRequest with body", () => {
    const signature = signRequest(
      privateKey,
      "1700000000000",
      "POST",
      "/api/1.0/orders",
      "",
      '{"symbol":"BTC-USD","side":"buy"}',
    );
    const decoded = Buffer.from(signature, "base64");
    expect(decoded.length).toBe(64);
  });

  it("signRequest with query", () => {
    const signature = signRequest(
      privateKey,
      "1700000000000",
      "GET",
      "/api/1.0/trades/BTC-USD",
      "limit=100",
    );
    const decoded = Buffer.from(signature, "base64");
    expect(decoded.length).toBe(64);
  });

  it("signRequest is deterministic", () => {
    const sig1 = signRequest(privateKey, "1700000000000", "GET", "/api/1.0/balances");
    const sig2 = signRequest(privateKey, "1700000000000", "GET", "/api/1.0/balances");
    expect(sig1).toBe(sig2);
  });

  it("signRequest differs for different methods", () => {
    const sigGet = signRequest(privateKey, "1700000000000", "GET", "/api/1.0/orders");
    const sigPost = signRequest(privateKey, "1700000000000", "POST", "/api/1.0/orders");
    expect(sigGet).not.toBe(sigPost);
  });

  it("buildAuthHeaders returns correct headers", () => {
    const apiKey = "a".repeat(64);
    const headers = buildAuthHeaders(apiKey, privateKey, "GET", "/api/1.0/balances");

    expect(headers["X-Revx-API-Key"]).toBe(apiKey);
    expect(headers["X-Revx-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["X-Revx-Signature"].length).toBeGreaterThan(0);

    const decoded = Buffer.from(headers["X-Revx-Signature"], "base64");
    expect(decoded.length).toBe(64);
  });
});
