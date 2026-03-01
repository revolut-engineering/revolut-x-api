/**
 * Tests for worker-ops tools — 3 tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWorkerTools } from "../../src/tools/worker-ops.js";

const mockWorkerClient = {
  getWorkerStatus: vi.fn(),
  stopWorker: vi.fn(),
  restartWorker: vi.fn(),
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
  registerWorkerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: any): string {
  return result.content[0].text ?? "";
}

describe("worker-ops tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("worker_status returns formatted status", async () => {
    mockWorkerClient.getWorkerStatus.mockResolvedValue({
      running: true,
      credentials_configured: true,
      status: "running",
      last_tick: "2024-01-01T12:00:00",
      last_error: null,
      active_alert_count: 3,
      enabled_connection_count: 1,
      uptime_seconds: 3600,
    });
    const client = await createClient();
    const result = await client.callTool({ name: "worker_status", arguments: {} });
    const text = getText(result);
    expect(text).toContain("Worker status: RUNNING");
    expect(text).toContain("Active alerts: 3");
    expect(text).toContain("configured");
  });

  it("worker_status handles unavailable worker", async () => {
    mockWorkerClient.getWorkerStatus.mockRejectedValue(
      new MockWorkerUnavailableError("unreachable"),
    );
    const client = await createClient();
    const result = await client.callTool({ name: "worker_status", arguments: {} });
    const text = getText(result);
    expect(text).toContain("STOPPED (unreachable)");
    expect(text).toContain("Worker not running message");
  });

  it("worker_stop succeeds", async () => {
    mockWorkerClient.stopWorker.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({ name: "worker_stop", arguments: {} });
    expect(getText(result)).toContain("Worker stop requested");
  });

  it("worker_stop when already stopped", async () => {
    mockWorkerClient.stopWorker.mockRejectedValue(
      new MockWorkerUnavailableError("not running"),
    );
    const client = await createClient();
    const result = await client.callTool({ name: "worker_stop", arguments: {} });
    expect(getText(result)).toContain("not running (already stopped)");
  });

  it("worker_restart succeeds", async () => {
    mockWorkerClient.restartWorker.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({ name: "worker_restart", arguments: {} });
    expect(getText(result)).toContain("Worker restart requested");
  });

  it("worker_restart when unavailable", async () => {
    mockWorkerClient.restartWorker.mockRejectedValue(
      new MockWorkerUnavailableError("not running"),
    );
    const client = await createClient();
    const result = await client.callTool({ name: "worker_restart", arguments: {} });
    const text = getText(result);
    expect(text).toContain("Cannot restart");
    expect(text).toContain("Worker not running message");
  });
});
