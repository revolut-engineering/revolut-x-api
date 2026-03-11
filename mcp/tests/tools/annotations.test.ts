import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/index.js";

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => ({})),
  SETUP_GUIDE: "Setup guide",
}));

vi.mock("revolutx-api", () => ({
  AuthNotConfiguredError: class extends Error {},
  ensureConfigDir: vi.fn(),
  getPrivateKeyFile: vi.fn(() => "/fake/path/private.pem"),
  getPublicKeyFile: vi.fn(() => "/fake/path/public.pem"),
  generateKeypair: vi.fn(),
  loadPrivateKey: vi.fn(),
  getPublicKeyPem: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(),
  isConfigured: vi.fn(() => false),
  loadCredentials: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => false) };
});

async function listTools() {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerAllTools(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  return tools;
}

const EXPECTED_TOOL_NAMES = [
  "generate_keypair",
  "configure_api_key",
  "check_auth_status",
  "get_balances",
  "get_currencies",
  "get_currency_pairs",
  "get_order_book",
  "get_tickers",
  "get_candles",
  "get_public_trades",
  "get_last_trades",
  "order_command",
  "get_active_orders",
  "get_client_trades",
  "grid_backtest",
  "grid_optimize",
  "monitor_command",
  "monitor_types",
  "connector_command",
];

describe("tool annotations", () => {
  it("all 19 tools are registered", async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(19);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every tool has a title annotation", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(tool.annotations?.title).toBeTruthy();
      expect(typeof tool.annotations?.title).toBe("string");
      expect((tool.annotations?.title as string).length).toBeLessThanOrEqual(
        64,
      );
    }
  });

  it("every tool has readOnlyHint annotation", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
    }
  });

  it("every tool has destructiveHint annotation", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(tool.annotations?.destructiveHint).toBeDefined();
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
    }
  });

  it("tool names are at most 64 characters", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });
});
