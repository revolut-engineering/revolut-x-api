/**
 * Tests for alert tools — 7 tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAlertTools } from "../../src/tools/alerts.js";

const mockWorkerClient = {
  createAlert: vi.fn(),
  listAlerts: vi.fn(),
  updateAlert: vi.fn(),
  deleteAlert: vi.fn(),
  getAlert: vi.fn(),
  getAlertTypes: vi.fn(),
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
  registerAlertTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: any): string {
  return result.content[0].text ?? "";
}

describe("alert tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alert_create creates price alert", async () => {
    mockWorkerClient.createAlert.mockResolvedValue({ id: "alert-1" });
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_create",
      arguments: { pair: "BTC-USD", direction: "above", threshold: "100000" },
    });
    const text = getText(result);
    expect(text).toContain("Alert created (id: alert-1)");
    expect(text).toContain("Type: price");
  });

  it("alert_create creates rsi alert with config", async () => {
    mockWorkerClient.createAlert.mockResolvedValue({ id: "alert-2" });
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_create",
      arguments: {
        pair: "BTC-USD",
        alert_type: "rsi",
        config: '{"period":14,"direction":"above","threshold":"70"}',
      },
    });
    const text = getText(result);
    expect(text).toContain("Alert created (id: alert-2)");
    expect(text).toContain("Type: rsi");
  });

  it("alert_create rejects invalid alert type", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_create",
      arguments: { pair: "BTC-USD", alert_type: "unknown_type" },
    });
    expect(getText(result)).toContain("Unknown alert type");
  });

  it("alert_create requires config for non-price types", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_create",
      arguments: { pair: "BTC-USD", alert_type: "rsi" },
    });
    expect(getText(result)).toContain("requires a config parameter");
  });

  it("alert_create returns worker not running", async () => {
    mockWorkerClient.createAlert.mockRejectedValue(
      new MockWorkerUnavailableError("unavailable"),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_create",
      arguments: { pair: "BTC-USD", direction: "above", threshold: "100000" },
    });
    expect(getText(result)).toContain("Worker not running message");
  });

  it("alert_list returns formatted list", async () => {
    mockWorkerClient.listAlerts.mockResolvedValue({
      data: [
        {
          id: "1",
          alert_type: "price",
          pair: "BTC-USD",
          enabled: true,
          triggered: false,
          config: { direction: "above", threshold: "100000" },
          poll_interval_sec: 10,
          current_value: null,
          last_checked_at: null,
        },
      ],
    });
    const client = await createClient();
    const result = await client.callTool({ name: "alert_list", arguments: {} });
    const text = getText(result);
    expect(text).toContain("Alerts (1)");
    expect(text).toContain("price");
    expect(text).toContain("BTC-USD");
  });

  it("alert_list returns empty message", async () => {
    mockWorkerClient.listAlerts.mockResolvedValue({ data: [] });
    const client = await createClient();
    const result = await client.callTool({ name: "alert_list", arguments: {} });
    expect(getText(result)).toContain("No alerts configured");
  });

  it("alert_enable succeeds", async () => {
    mockWorkerClient.updateAlert.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_enable",
      arguments: { alert_id: "1" },
    });
    expect(getText(result)).toContain("Alert 1 enabled");
  });

  it("alert_disable succeeds", async () => {
    mockWorkerClient.updateAlert.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_disable",
      arguments: { alert_id: "1" },
    });
    expect(getText(result)).toContain("Alert 1 disabled");
  });

  it("alert_delete returns 404", async () => {
    mockWorkerClient.deleteAlert.mockRejectedValue(
      new MockWorkerAPIError("not found", 404),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_delete",
      arguments: { alert_id: "999" },
    });
    expect(getText(result)).toContain("Alert 999 not found");
  });

  it("alert_delete succeeds", async () => {
    mockWorkerClient.deleteAlert.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_delete",
      arguments: { alert_id: "1" },
    });
    expect(getText(result)).toContain("Alert 1 deleted");
  });

  it("alert_get returns full details", async () => {
    mockWorkerClient.getAlert.mockResolvedValue({
      id: "1",
      alert_type: "price",
      pair: "BTC-USD",
      config: { direction: "above", threshold: "100000" },
      enabled: true,
      triggered: false,
      poll_interval_sec: 10,
      current_value: { label: "Price", value: "99500" },
      connection_ids: null,
      last_checked_at: "2024-01-01",
      last_triggered_at: null,
      created_at: "2024-01-01",
      updated_at: "2024-01-01",
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_get",
      arguments: { alert_id: "1" },
    });
    const text = getText(result);
    expect(text).toContain("Alert 1");
    expect(text).toContain("Price: 99500");
  });

  it("alert_types falls back to cached docs when worker unavailable", async () => {
    mockWorkerClient.getAlertTypes.mockRejectedValue(
      new MockWorkerUnavailableError("unavailable"),
    );
    const client = await createClient();
    const result = await client.callTool({ name: "alert_types", arguments: {} });
    const text = getText(result);
    expect(text).toContain("Supported Alert Types");
    expect(text).toContain("price");
    expect(text).toContain("rsi");
    expect(text).toContain("Worker offline");
  });

  it("alert_create handles 422 validation error", async () => {
    mockWorkerClient.createAlert.mockRejectedValue(
      new MockWorkerAPIError("Missing required field", 422),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "alert_create",
      arguments: { pair: "BTC-USD", direction: "above", threshold: "100000" },
    });
    expect(getText(result)).toContain("Invalid alert configuration");
  });
});
