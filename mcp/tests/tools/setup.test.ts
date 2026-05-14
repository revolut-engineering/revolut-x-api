import type { KeyObject } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSetupTools } from "../../src/tools/setup.js";

vi.mock("@revolut/revolut-x-api", () => ({
  ensureConfigDir: vi.fn(),
  getPrivateKeyFile: vi.fn(() => "/fake/path/private.pem"),
  getPublicKeyFile: vi.fn(() => "/fake/path/public.pem"),
  generateKeypair: vi.fn(
    () => "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n",
  ),
  loadPrivateKey: vi.fn(() => ({ asymmetricKeyType: "ed25519" })),
  getPublicKeyPem: vi.fn(
    () => "-----BEGIN PUBLIC KEY-----\nexisting\n-----END PUBLIC KEY-----\n",
  ),
  loadConfig: vi.fn(() => ({ api_key: "", private_key_path: "" })),
  saveConfig: vi.fn(),
  isConfigured: vi.fn(() => false),
  loadCredentials: vi.fn(() => null),
}));

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => ({
    getCurrencies: vi.fn(async () => ({ BTC: {}, ETH: {}, SOL: {} })),
  })),
  resetRevolutXClient: vi.fn(),
  SETUP_GUIDE: "Setup guide text",
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerSetupTools(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result)) return "";
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

describe("setup tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generate_keypair creates new keypair when none exists", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const client = await createClient();
    const result = await client.callTool({
      name: "generate_keypair",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Ed25519 keypair generated successfully");
    expect(text).toContain("PUBLIC key");
  });

  it("generate_keypair returns existing key when found", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const client = await createClient();
    const result = await client.callTool({
      name: "generate_keypair",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("A keypair already exists");
  });

  it("configure_api_key rejects invalid key format", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "configure_api_key",
      arguments: { api_key: "tooshort" },
    });
    const text = getText(result);
    expect(text).toContain("Invalid API key format");
  });

  it("configure_api_key saves valid key", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const client = await createClient();
    const validKey = "A".repeat(64);
    const result = await client.callTool({
      name: "configure_api_key",
      arguments: { api_key: validKey },
    });
    const text = getText(result);
    expect(text).toContain("API key saved successfully");
  });

  it("check_auth_status returns not configured when not set up", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "check_auth_status",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Not configured");
  });

  it("check_auth_status returns success when configured and working", async () => {
    const api = await import("@revolut/revolut-x-api");
    vi.mocked(api.isConfigured).mockReturnValue(true);
    vi.mocked(api.loadCredentials).mockReturnValue({
      apiKey: "x",
      privateKey: {} as KeyObject,
      privateKeyPath: "/tmp/private.pem",
    });

    const client = await createClient();
    const result = await client.callTool({
      name: "check_auth_status",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Authentication is configured");
    expect(text).toContain("connection is working");
  });
});
