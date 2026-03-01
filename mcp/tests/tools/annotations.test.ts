/**
 * Annotation tests — verify all 35 tools are registered with correct annotations.
 * Uses in-memory transport to list tools via the MCP protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/index.js";

// Mock all external dependencies so tools can register without side effects
vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => ({})),
  getWorkerClient: vi.fn(() => ({})),
}));

vi.mock("../../src/shared/settings.js", () => ({
  ensureConfigDir: vi.fn(),
  getPrivateKeyFile: vi.fn(() => "/fake/path/private.pem"),
  getPublicKeyFile: vi.fn(() => "/fake/path/public.pem"),
  setFilePermissions600: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(),
  isConfigured: vi.fn(() => false),
}));

vi.mock("../../src/shared/auth/keypair.js", () => ({
  generateEd25519Keypair: vi.fn(),
  loadPrivateKey: vi.fn(),
  getPublicKeyPem: vi.fn(),
}));

vi.mock("../../src/shared/auth/credentials.js", () => ({
  SETUP_GUIDE: "Setup guide",
  loadCredentials: vi.fn(),
}));

vi.mock("../../src/shared/client/exceptions.js", () => ({
  AuthNotConfiguredError: class extends Error {},
  WorkerUnavailableError: class extends Error {},
  WorkerAPIError: class extends Error {
    statusCode: number;
    constructor(msg: string, code: number) { super(msg); this.statusCode = code; }
  },
}));

vi.mock("../../src/shared/client/worker-client.js", () => ({
  WORKER_NOT_RUNNING: "Worker not running",
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => false) };
});

async function listTools() {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerAllTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  return tools;
}

const EXPECTED_TOOL_NAMES = [
  // Setup (3)
  "generate_keypair",
  "configure_api_key",
  "check_auth_status",
  // Account (1)
  "get_balances",
  // Market Data (7)
  "get_currencies",
  "get_currency_pairs",
  "get_order_book",
  "get_tickers",
  "get_candles",
  "get_public_trades",
  "get_last_trades",
  // Trading (5)
  "place_market_order",
  "place_limit_order",
  "get_active_orders",
  "cancel_order",
  "get_client_trades",
  // Backtest (2)
  "grid_backtest",
  "grid_optimize",
  // Alerts (7)
  "alert_create",
  "alert_list",
  "alert_enable",
  "alert_disable",
  "alert_delete",
  "alert_get",
  "alert_types",
  // Telegram (6)
  "telegram_add_connection",
  "telegram_list_connections",
  "telegram_delete_connection",
  "telegram_enable_connection",
  "telegram_disable_connection",
  "telegram_test_connection",
  // Worker Ops (3)
  "worker_status",
  "worker_stop",
  "worker_restart",
  // Events (1)
  "events_list",
];

describe("tool annotations", () => {
  it("all 35 tools are registered", async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(35);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every tool has a title annotation", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(tool.annotations?.title).toBeTruthy();
      expect(typeof tool.annotations?.title).toBe("string");
      expect((tool.annotations?.title as string).length).toBeLessThanOrEqual(64);
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
