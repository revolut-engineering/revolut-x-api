/**
 * Tests for telegram tools — 6 tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTelegramTools } from "../../src/tools/telegram.js";

const mockWorkerClient = {
  createConnection: vi.fn(),
  listConnections: vi.fn(),
  deleteConnection: vi.fn(),
  updateConnection: vi.fn(),
  testConnection: vi.fn(),
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
  registerTelegramTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: any): string {
  return result.content[0].text ?? "";
}

describe("telegram tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("telegram_add_connection succeeds with test", async () => {
    mockWorkerClient.createConnection.mockResolvedValue({
      id: "conn-1",
      test_result: { success: true },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_add_connection",
      arguments: { bot_token: "123:ABC", chat_id: "456" },
    });
    const text = getText(result);
    expect(text).toContain("Telegram connection added (id: conn-1");
    expect(text).toContain("Test message sent successfully");
  });

  it("telegram_add_connection handles 422", async () => {
    mockWorkerClient.createConnection.mockRejectedValue(
      new MockWorkerAPIError("invalid token", 422),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_add_connection",
      arguments: { bot_token: "bad", chat_id: "456" },
    });
    expect(getText(result)).toContain("Invalid connection configuration");
  });

  it("telegram_add_connection handles worker unavailable", async () => {
    mockWorkerClient.createConnection.mockRejectedValue(
      new MockWorkerUnavailableError("unavailable"),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_add_connection",
      arguments: { bot_token: "123:ABC", chat_id: "456" },
    });
    expect(getText(result)).toContain("Worker not running message");
  });

  it("telegram_list_connections returns formatted list", async () => {
    mockWorkerClient.listConnections.mockResolvedValue({
      data: [
        {
          id: "conn-1",
          label: "default",
          chat_id: "456",
          bot_token_redacted: "123:A***",
          enabled: true,
          last_tested_at: "2024-01-01",
        },
      ],
    });
    const client = await createClient();
    const result = await client.callTool({ name: "telegram_list_connections", arguments: {} });
    const text = getText(result);
    expect(text).toContain("Telegram connections (1)");
    expect(text).toContain("conn-1");
  });

  it("telegram_list_connections returns empty message", async () => {
    mockWorkerClient.listConnections.mockResolvedValue({ data: [] });
    const client = await createClient();
    const result = await client.callTool({ name: "telegram_list_connections", arguments: {} });
    expect(getText(result)).toContain("No Telegram connections configured");
  });

  it("telegram_delete_connection succeeds", async () => {
    mockWorkerClient.deleteConnection.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_delete_connection",
      arguments: { connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("conn-1 deleted");
  });

  it("telegram_delete_connection handles 404", async () => {
    mockWorkerClient.deleteConnection.mockRejectedValue(
      new MockWorkerAPIError("not found", 404),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_delete_connection",
      arguments: { connection_id: "conn-99" },
    });
    expect(getText(result)).toContain("Connection conn-99 not found");
  });

  it("telegram_enable_connection succeeds", async () => {
    mockWorkerClient.updateConnection.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_enable_connection",
      arguments: { connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("conn-1 enabled");
  });

  it("telegram_disable_connection succeeds", async () => {
    mockWorkerClient.updateConnection.mockResolvedValue({});
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_disable_connection",
      arguments: { connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("conn-1 disabled");
  });

  it("telegram_test_connection succeeds", async () => {
    mockWorkerClient.testConnection.mockResolvedValue({ success: true });
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_test_connection",
      arguments: { connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("Test message sent successfully");
  });
});
