import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerEventsCommand } from "../../src/commands/events.js";

const mockLoadEvents = vi.fn();

vi.mock("../../src/db/store.js", () => ({
  loadEvents: (...args: unknown[]) => mockLoadEvents(...args),
}));

vi.mock("api-k9x2a", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getConfigDir: () => "/tmp/revx-test",
    ensureConfigDir: () => {},
  };
});

const sampleEvents = [
  {
    id: "e1",
    ts: "2025-01-01T10:00:00.000Z",
    category: "alert_triggered",
    details: { pair: "BTC-USD", price: "100000" },
  },
  {
    id: "e2",
    ts: "2025-01-02T10:00:00.000Z",
    category: "notification_sent",
    details: { pair: "ETH-USD" },
  },
];

describe("events command", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerEventsCommand(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockLoadEvents.mockReturnValue(sampleEvents);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("loads events with default limit of 50", async () => {
    await program.parseAsync(["node", "revx", "events"]);
    expect(mockLoadEvents).toHaveBeenCalledWith({
      category: undefined,
      limit: 50,
    });
  });

  it("displays table with event data", async () => {
    await program.parseAsync(["node", "revx", "events"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("alert_triggered");
  });

  it("passes --category filter to loadEvents", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "events",
      "--category",
      "alert_triggered",
    ]);
    expect(mockLoadEvents).toHaveBeenCalledWith({
      category: "alert_triggered",
      limit: 50,
    });
  });

  it("passes --limit to loadEvents", async () => {
    await program.parseAsync(["node", "revx", "events", "--limit", "10"]);
    expect(mockLoadEvents).toHaveBeenCalledWith({
      category: undefined,
      limit: 10,
    });
  });

  it("outputs JSON when --json flag is set", async () => {
    await program.parseAsync(["node", "revx", "events", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].category).toBe("alert_triggered");
  });

  it("shows empty message when no events found", async () => {
    mockLoadEvents.mockReturnValue([]);
    await program.parseAsync(["node", "revx", "events"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No events found");
  });

  it("shows category-specific empty message with --category filter", async () => {
    mockLoadEvents.mockReturnValue([]);
    await program.parseAsync([
      "node",
      "revx",
      "events",
      "--category",
      "alert_triggered",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No events found");
  });
});
