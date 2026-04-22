import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAccountTools } from "../../src/tools/account.js";

const mockGetBalances = vi.fn();

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => ({
    getBalances: mockGetBalances,
  })),
  SETUP_GUIDE: "Setup guide text",
}));

vi.mock("api-k9x2a", async () => {
  class AuthNotConfiguredError extends Error {
    name = "AuthNotConfiguredError";
  }
  class ForbiddenError extends Error {
    name = "ForbiddenError";
  }
  class RateLimitError extends Error {
    name = "RateLimitError";
  }
  class ServerError extends Error {
    name = "ServerError";
  }
  class InsecureKeyPermissionsError extends Error {
    name = "InsecureKeyPermissionsError";
  }
  return {
    AuthNotConfiguredError,
    ForbiddenError,
    RateLimitError,
    ServerError,
    InsecureKeyPermissionsError,
  };
});

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerAccountTools(server);
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

describe("account tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("get_balances returns formatted table", async () => {
    mockGetBalances.mockResolvedValue([
      { currency: "BTC", available: "0.5", reserved: "0.1", total: "0.6" },
      { currency: "USD", available: "1000", reserved: "0", total: "1000" },
    ]);

    const client = await createClient();
    const result = await client.callTool({
      name: "get_balances",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("BTC");
    expect(text).toContain("0.5");
    expect(text).toContain("USD");
  });

  it("get_balances returns empty message when no balances", async () => {
    mockGetBalances.mockResolvedValue([]);

    const client = await createClient();
    const result = await client.callTool({
      name: "get_balances",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("No balances found");
  });

  it("get_balances returns setup guide on auth error", async () => {
    const { AuthNotConfiguredError } = await import("api-k9x2a");
    mockGetBalances.mockRejectedValue(
      new AuthNotConfiguredError("not configured"),
    );

    const client = await createClient();
    const result = await client.callTool({
      name: "get_balances",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Setup guide text");
  });

  it("get_balances returns help message on forbidden error", async () => {
    const { ForbiddenError } = await import("api-k9x2a");
    mockGetBalances.mockRejectedValue(new ForbiddenError("access denied"));

    const client = await createClient();
    const result = await client.callTool({
      name: "get_balances",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Access Forbidden");
    expect(text).toContain("Add public key");
  });
});
