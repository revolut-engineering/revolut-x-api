/**
 * Tests for events tools — events_list.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerEventTools } from "../../src/tools/events.js";

const mockWorkerClient = {
  listEvents: vi.fn(),
};

vi.mock("../../src/server.js", () => ({
  getWorkerClient: vi.fn(() => mockWorkerClient),
}));

class MockWorkerUnavailableError extends Error {
  name = "WorkerUnavailableError";
}
class MockWorkerAPIError extends Error {
  name = "WorkerAPIError";
  statusCode: number;
  constructor(msg: string, code: number) {
    super(msg);
    this.statusCode = code;
  }
}

vi.mock("../../src/shared/client/exceptions.js", () => ({
  WorkerUnavailableError: MockWorkerUnavailableError,
  WorkerAPIError: MockWorkerAPIError,
}));

vi.mock("../../src/shared/client/worker-client.js", () => ({
  WORKER_NOT_RUNNING: "Worker not running message",
}));

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerEventTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: any): string {
  return result.content[0].text ?? "";
}

describe("events tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("events_list returns formatted events", async () => {
    mockWorkerClient.listEvents.mockResolvedValue({
      data: [
        { ts: "2024-01-01T12:00:00", category: "alert_triggered", details: { alert_id: "1", pair: "BTC-USD" } },
        { ts: "2024-01-01T11:00:00", category: "worker", details: { action: "restart" } },
      ],
      total: 10,
    });
    const client = await createClient();
    const result = await client.callTool({ name: "events_list", arguments: {} });
    const text = getText(result);
    expect(text).toContain("Events (2 of 10)");
    expect(text).toContain("alert_triggered");
    expect(text).toContain("alert_id=1");
  });

  it("events_list with category filter", async () => {
    mockWorkerClient.listEvents.mockResolvedValue({
      data: [
        { ts: "2024-01-01T12:00:00", category: "alert_triggered", details: {} },
      ],
      total: 1,
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "events_list",
      arguments: { category: "alert_triggered" },
    });
    const text = getText(result);
    expect(text).toContain("[category=alert_triggered]");
  });

  it("events_list returns empty message", async () => {
    mockWorkerClient.listEvents.mockResolvedValue({ data: [], total: 0 });
    const client = await createClient();
    const result = await client.callTool({ name: "events_list", arguments: {} });
    expect(getText(result)).toContain("No events found");
  });

  it("events_list handles worker unavailable", async () => {
    mockWorkerClient.listEvents.mockRejectedValue(
      new MockWorkerUnavailableError("unreachable"),
    );
    const client = await createClient();
    const result = await client.callTool({ name: "events_list", arguments: {} });
    expect(getText(result)).toContain("Worker not running message");
  });
});
