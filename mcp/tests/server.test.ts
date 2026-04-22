import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRevolutXClient = vi.hoisted(() => vi.fn());

vi.mock("api-k9x2a", () => ({
  RevolutXClient: mockRevolutXClient,
}));

import { getRevolutXClient, resetRevolutXClient } from "../src/server.js";

describe("getRevolutXClient", () => {
  beforeEach(() => {
    resetRevolutXClient();
    mockRevolutXClient.mockClear();
  });

  it("creates client with isAgent and enforceKeyPermissions", () => {
    getRevolutXClient();
    expect(mockRevolutXClient).toHaveBeenCalledWith({
      isAgent: true,
      enforceKeyPermissions: true,
    });
  });

  it("returns the same instance on subsequent calls", () => {
    const first = getRevolutXClient();
    const second = getRevolutXClient();
    expect(first).toBe(second);
    expect(mockRevolutXClient).toHaveBeenCalledTimes(1);
  });

  it("creates a new instance after reset", () => {
    getRevolutXClient();
    resetRevolutXClient();
    getRevolutXClient();
    expect(mockRevolutXClient).toHaveBeenCalledTimes(2);
  });
});
