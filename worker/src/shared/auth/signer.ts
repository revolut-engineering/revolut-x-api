import { sign, type KeyObject } from "node:crypto";

export function createTimestamp(): string {
  return String(Date.now());
}

export function signRequest(
  privateKey: KeyObject,
  timestamp: string,
  method: string,
  path: string,
  query: string = "",
  body: string = "",
): string {
  const message = `${timestamp}${method.toUpperCase()}${path}${query}${body}`;
  const signature = sign(null, Buffer.from(message, "utf-8"), privateKey);
  return signature.toString("base64");
}

export function buildAuthHeaders(
  apiKey: string,
  privateKey: KeyObject,
  method: string,
  path: string,
  query: string = "",
  body: string = "",
): Record<string, string> {
  const timestamp = createTimestamp();
  const signature = signRequest(privateKey, timestamp, method, path, query, body);
  return {
    "X-Revx-API-Key": apiKey,
    "X-Revx-Timestamp": timestamp,
    "X-Revx-Signature": signature,
  };
}
