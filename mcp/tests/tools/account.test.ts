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
    const { AuthNotConfiguredError } = await import("@revolut/revolut-x-api");
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
    expect(result.isError).toBe(true);
  });

  it("get_balances returns help message on forbidden error", async () => {
    const { ForbiddenError } = await import("@revolut/revolut-x-api");
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

  it("get_balances says what is wrong with credentials it can't use", async () => {
    const { InvalidCredentialsError } = await import("@revolut/revolut-x-api");
    mockGetBalances.mockRejectedValue(
      new InvalidCredentialsError({
        file: "private_key",
        fault: "malformed",
        path: "/cfg/private.pem",
        problem:
          "The private key /cfg/private.pem is not a valid PEM private key.",
      }),
    );

    const client = await createClient();
    const text = getText(
      await client.callTool({ name: "get_balances", arguments: {} }),
    );

    expect(text).toContain(
      "The private key /cfg/private.pem is not a valid PEM private key.",
    );
    expect(text).toContain("'generate_keypair' moves this key aside");
    expect(text).toContain("Setup guide text");
  });

  it("get_balances reports a wrong API URL on its own", async () => {
    const { ConfigurationError } = await import("@revolut/revolut-x-api");
    mockGetBalances.mockRejectedValue(
      new ConfigurationError(
        'The API URL (REVOLUTX_API_URL) must start with https://. Got "http://x".',
      ),
    );

    const client = await createClient();
    const text = getText(
      await client.callTool({ name: "get_balances", arguments: {} }),
    );

    expect(text).toContain("correct the API URL setting");
    expect(text).not.toContain("Setup guide text");
  });

  it("get_balances explains a key the exchange refuses", async () => {
    const { AuthenticationError } = await import("@revolut/revolut-x-api");
    mockGetBalances.mockRejectedValue(
      new AuthenticationError("Unable to resolve API key"),
    );

    const client = await createClient();
    const result = await client.callTool({
      name: "get_balances",
      arguments: {},
    });

    expect(getText(result)).toContain(
      "The exchange refused the credentials: Unable to resolve API key",
    );
    expect(getText(result)).toContain("public key is registered");
    expect(result.isError).toBe(true);
  });
});
