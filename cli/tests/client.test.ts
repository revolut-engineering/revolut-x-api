import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRevolutXClient = vi.fn();

vi.mock("api-k9x2a", () => ({
  RevolutXClient: mockRevolutXClient,
}));

// Reset module cache between tests so cachedClient is cleared
beforeEach(async () => {
  vi.resetModules();
  mockRevolutXClient.mockClear();
});

describe("getClient", () => {
  it("creates client with isAgent: true", async () => {
    const { getClient } = await import("../src/util/client.js");
    getClient();
    expect(mockRevolutXClient).toHaveBeenCalledWith({ isAgent: true });
  });

  it("returns the same instance on subsequent calls", async () => {
    const { getClient } = await import("../src/util/client.js");
    const first = getClient();
    const second = getClient();
    expect(first).toBe(second);
    expect(mockRevolutXClient).toHaveBeenCalledTimes(1);
  });
});
