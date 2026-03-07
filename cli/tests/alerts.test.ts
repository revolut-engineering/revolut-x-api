import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revx-test-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

vi.mock("revolutx-api", () => ({
  getConfigDir: () => tempDir,
  ensureConfigDir: () => {},
}));

const { createAlert, loadAlerts, getAlert, updateAlert, deleteAlert } =
  await import("../src/db/store.js");

describe("alerts store", () => {
  it("creates an alert with valid fields", () => {
    const alert = createAlert(
      "BTC-USD",
      "price",
      { direction: "above", threshold: "100000" },
      10,
    );
    expect(alert.id).toBeTruthy();
    expect(alert.pair).toBe("BTC-USD");
    expect(alert.alert_type).toBe("price");
    expect(alert.config).toEqual({ direction: "above", threshold: "100000" });
    expect(alert.poll_interval_sec).toBe(10);
    expect(alert.enabled).toBe(true);
    expect(alert.created_at).toBeTruthy();
    expect(alert.updated_at).toBeTruthy();
  });

  it("persists alert to JSON file", () => {
    createAlert("ETH-USD", "rsi", { period: 14 }, 30);
    const raw = JSON.parse(readFileSync(join(tempDir, "alerts.json"), "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].pair).toBe("ETH-USD");
  });

  it("loads empty array when no file", () => {
    expect(loadAlerts()).toEqual([]);
  });

  it("loads alerts from file", () => {
    createAlert("BTC-USD", "price", {}, 10);
    createAlert("ETH-USD", "rsi", {}, 20);
    const alerts = loadAlerts();
    expect(alerts).toHaveLength(2);
  });

  it("gets alert by ID", () => {
    const created = createAlert("BTC-USD", "price", {}, 10);
    const found = getAlert(created.id);
    expect(found).toBeTruthy();
    expect(found.id).toBe(created.id);
  });

  it("returns undefined for unknown ID", () => {
    expect(getAlert("nonexistent")).toBeUndefined();
  });

  it("updates alert enabled status", () => {
    const created = createAlert("BTC-USD", "price", {}, 10);
    expect(created.enabled).toBe(true);
    const updated = updateAlert(created.id, { enabled: false });
    expect(updated).toBeTruthy();
    expect(updated.enabled).toBe(false);
    const reloaded = getAlert(created.id);
    expect(reloaded.enabled).toBe(false);
  });

  it("returns undefined when updating nonexistent alert", () => {
    expect(updateAlert("nonexistent", { enabled: false })).toBeUndefined();
  });

  it("deletes alert", () => {
    const created = createAlert("BTC-USD", "price", {}, 10);
    expect(deleteAlert(created.id)).toBe(true);
    expect(getAlert(created.id)).toBeUndefined();
    expect(loadAlerts()).toHaveLength(0);
  });

  it("returns false when deleting nonexistent alert", () => {
    expect(deleteAlert("nonexistent")).toBe(false);
  });

  it("handles multiple alerts independently", () => {
    const a1 = createAlert("BTC-USD", "price", {}, 10);
    const a2 = createAlert("ETH-USD", "rsi", {}, 20);
    deleteAlert(a1.id);
    expect(loadAlerts()).toHaveLength(1);
    expect(loadAlerts()[0].id).toBe(a2.id);
  });
});
