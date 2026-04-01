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

vi.mock("api-k9x2a", () => ({
  getConfigDir: () => tempDir,
  ensureConfigDir: () => {},
}));

const {
  createConnection,
  loadConnections,
  getConnection,
  updateConnection,
  deleteConnection,
} = await import("../src/db/store.js");

describe("telegram store", () => {
  it("creates a connection with valid fields", () => {
    const conn = createConnection("123:ABC", "456", "mybot");
    expect(conn.id).toBeTruthy();
    expect(conn.bot_token).toBe("123:ABC");
    expect(conn.chat_id).toBe("456");
    expect(conn.label).toBe("mybot");
    expect(conn.enabled).toBe(true);
    expect(conn.created_at).toBeTruthy();
  });

  it("persists connection to JSON file", () => {
    createConnection("123:ABC", "456", "default");
    const raw = JSON.parse(
      readFileSync(join(tempDir, "telegram.json"), "utf-8"),
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].label).toBe("default");
  });

  it("loads empty array when no file", () => {
    expect(loadConnections()).toEqual([]);
  });

  it("loads connections from file", () => {
    createConnection("t1", "c1", "bot1");
    createConnection("t2", "c2", "bot2");
    expect(loadConnections()).toHaveLength(2);
  });

  it("gets connection by ID", () => {
    const created = createConnection("123:ABC", "456", "mybot");
    const found = getConnection(created.id);
    expect(found).toBeTruthy();
    expect(found!.id).toBe(created.id);
  });

  it("returns undefined for unknown ID", () => {
    expect(getConnection("nonexistent")).toBeUndefined();
  });

  it("updates connection enabled status", () => {
    const created = createConnection("123:ABC", "456", "mybot");
    const updated = updateConnection(created.id, { enabled: false });
    expect(updated).toBeTruthy();
    expect(updated!.enabled).toBe(false);
    const reloaded = getConnection(created.id);
    expect(reloaded!.enabled).toBe(false);
  });

  it("returns undefined when updating nonexistent connection", () => {
    expect(updateConnection("nonexistent", { enabled: false })).toBeUndefined();
  });

  it("deletes connection", () => {
    const created = createConnection("123:ABC", "456", "mybot");
    expect(deleteConnection(created.id)).toBe(true);
    expect(getConnection(created.id)).toBeUndefined();
    expect(loadConnections()).toHaveLength(0);
  });

  it("returns false when deleting nonexistent connection", () => {
    expect(deleteConnection("nonexistent")).toBe(false);
  });

  it("handles multiple connections independently", () => {
    const c1 = createConnection("t1", "c1", "bot1");
    const c2 = createConnection("t2", "c2", "bot2");
    deleteConnection(c1.id);
    expect(loadConnections()).toHaveLength(1);
    expect(loadConnections()[0].id).toBe(c2.id);
  });
});
