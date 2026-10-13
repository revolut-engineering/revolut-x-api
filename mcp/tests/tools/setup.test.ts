import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AuthenticationError,
  ConfigurationError,
  NetworkError,
} from "@revolut/revolut-x-api";
import { registerSetupTools } from "../../src/tools/setup.js";

const server = vi.hoisted(() => ({
  getCurrencies: vi.fn(),
  getRevolutXClient: vi.fn(),
  resetRevolutXClient: vi.fn(),
}));

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: server.getRevolutXClient,
  resetRevolutXClient: server.resetRevolutXClient,
  SETUP_GUIDE: "Setup guide text",
}));

const API_KEY = "K".repeat(64);
const posix = platform() !== "win32";

async function createClient(): Promise<Client> {
  const mcp = new McpServer({ name: "test", version: "0.0.1" });
  registerSetupTools(mcp);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result)) return "";
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

function ed25519Pem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}

describe("setup tools", () => {
  let dir: string;
  let client: Client;
  const previousDir = process.env.REVOLUTX_CONFIG_DIR;

  const configPath = () => join(dir, "config.json");
  const keyPath = () => join(dir, "private.pem");

  function writeConfig(content: unknown, mode = 0o600): void {
    writeFileSync(
      configPath(),
      typeof content === "string" ? content : JSON.stringify(content),
      { mode },
    );
    chmodSync(configPath(), mode);
  }

  function writeKey(content: string, mode = 0o600): void {
    writeFileSync(keyPath(), content, { mode });
    chmodSync(keyPath(), mode);
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    return getText(await client.callTool({ name, arguments: args }));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "revx-mcp-setup-"));
    process.env.REVOLUTX_CONFIG_DIR = dir;
    server.getCurrencies.mockResolvedValue({ BTC: {} });
    server.getRevolutXClient.mockImplementation(() => ({
      getCurrencies: server.getCurrencies,
    }));
    client = await createClient();
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.REVOLUTX_CONFIG_DIR;
    else process.env.REVOLUTX_CONFIG_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });

  describe("generate_keypair", () => {
    it("creates a new keypair when none exists", async () => {
      const text = await call("generate_keypair");

      expect(text).toContain("Ed25519 keypair generated successfully");
      expect(text).toContain("BEGIN PUBLIC KEY");
      expect(createPrivateKey(readFileSync(keyPath())).asymmetricKeyType).toBe(
        "ed25519",
      );
      expect(server.resetRevolutXClient).toHaveBeenCalled();
    });

    it("returns the existing key and leaves it alone", async () => {
      const pem = ed25519Pem();
      writeKey(pem);

      const text = await call("generate_keypair");

      expect(text).toContain("A keypair already exists");
      expect(text).toContain(`ask the user to move ${keyPath()} aside first`);
      expect(readFileSync(keyPath(), "utf-8")).toBe(pem);
    });

    it("moves a broken key aside before making a new one", async () => {
      writeKey("junk");

      const text = await call("generate_keypair");

      const moved = readdirSync(dir).find((name) =>
        name.startsWith("private.pem.replaced-"),
      );
      expect(readFileSync(join(dir, moved!), "utf-8")).toBe("junk");
      expect(text).toContain(
        `The old private key was moved to ${join(dir, moved!)}.`,
      );
      expect(createPrivateKey(readFileSync(keyPath())).asymmetricKeyType).toBe(
        "ed25519",
      );
    });

    it.skipIf(!posix)(
      "replaces a key others could read with one only the owner can",
      async () => {
        writeKey(ed25519Pem(), 0o644);

        await call("generate_keypair");

        expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
        expect(
          readdirSync(dir).some((name) =>
            name.startsWith("private.pem.replaced-"),
          ),
        ).toBe(true);
      },
    );

    it("moves aside a broken key kept at another path and replaces it there", async () => {
      const custom = join(dir, "custom.pem");
      writeFileSync(custom, "junk", { mode: 0o600 });
      writeConfig({ api_key: API_KEY, private_key_path: custom });

      await call("generate_keypair");

      expect(createPrivateKey(readFileSync(custom)).asymmetricKeyType).toBe(
        "ed25519",
      );
      expect(existsSync(keyPath())).toBe(false);
      expect(
        readdirSync(dir).some((name) =>
          name.startsWith("custom.pem.replaced-"),
        ),
      ).toBe(true);
      expect(await call("check_auth_status")).toContain(
        "connection is working",
      );
    });

    it("makes a new key at the usual path when the key at another path is gone", async () => {
      writeConfig({
        api_key: API_KEY,
        private_key_path: join(dir, "gone.pem"),
      });

      await call("generate_keypair");

      expect(createPrivateKey(readFileSync(keyPath())).asymmetricKeyType).toBe(
        "ed25519",
      );
    });

    it("asks the user about a folder where the key should be", async () => {
      mkdirSync(keyPath());

      const text = await call("generate_keypair");

      expect(text).toContain(`The private key ${keyPath()} is not a file.`);
      expect(text).toContain(`move the folder ${keyPath()} out of the way`);
      expect(readdirSync(dir)).toEqual(["private.pem"]);
    });
  });

  describe("configure_api_key", () => {
    it("rejects an invalid key format", async () => {
      const result = await client.callTool({
        name: "configure_api_key",
        arguments: { api_key: "short" },
      });

      expect(getText(result)).toContain("Invalid API key format");
      expect(result.isError).toBe(true);
    });

    it("saves a valid key next to an existing private key", async () => {
      writeKey(ed25519Pem());

      const result = await client.callTool({
        name: "configure_api_key",
        arguments: { api_key: API_KEY },
      });

      expect(getText(result)).toContain("API key saved successfully");
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(readFileSync(configPath(), "utf-8"))).toEqual({
        api_key: API_KEY,
        private_key_path: keyPath(),
      });
      expect(server.resetRevolutXClient).toHaveBeenCalled();
    });

    it("asks for a keypair first when there is none", async () => {
      const text = await call("configure_api_key", { api_key: API_KEY });

      expect(text).toContain("No private key found");
      expect(existsSync(configPath())).toBe(false);
    });

    it("replaces a config file that is not valid JSON", async () => {
      writeKey(ed25519Pem());
      writeConfig("{ broken");

      await call("configure_api_key", { api_key: API_KEY });

      expect(JSON.parse(readFileSync(configPath(), "utf-8")).api_key).toBe(
        API_KEY,
      );
    });

    it("asks the user about a folder where the config should be", async () => {
      writeKey(ed25519Pem());
      mkdirSync(configPath());

      const text = await call("configure_api_key", { api_key: API_KEY });

      expect(text).toContain(`The config file ${configPath()} is not a file.`);
    });

    it.skipIf(!posix)(
      "gives config-file advice, not key advice, for a config others can read",
      async () => {
        writeKey(ed25519Pem());
        writeConfig({ api_key: API_KEY }, 0o644);

        const text = await call("configure_api_key", { api_key: API_KEY });

        expect(text).toContain("no new key pair is needed");
        expect(text).not.toContain("generate_keypair");
      },
    );
  });

  describe("check_auth_status", () => {
    it("reports a missing setup as a status, not as a failed call", async () => {
      const result = await client.callTool({
        name: "check_auth_status",
        arguments: {},
      });

      expect(getText(result)).toContain("Not configured");
      expect(result.isError).toBeUndefined();
    });

    it("tests a fresh client and reports success", async () => {
      writeConfig({ api_key: API_KEY });
      writeKey(ed25519Pem());

      const text = await call("check_auth_status");

      expect(text).toContain("connection is working");
      expect(
        server.resetRevolutXClient.mock.invocationCallOrder[0],
      ).toBeLessThan(server.getRevolutXClient.mock.invocationCallOrder[0]);
    });

    it("says what is wrong with credentials it can't use, and what fixes it", async () => {
      writeConfig({ api_key: API_KEY });
      writeKey("not a key");

      const text = await call("check_auth_status");

      expect(text).toContain(
        `The private key ${keyPath()} is not a valid PEM private key.`,
      );
      expect(text).toContain("'generate_keypair' moves this key aside");
      expect(server.getRevolutXClient).not.toHaveBeenCalled();
    });

    it("reports a wrong API URL on its own", async () => {
      writeConfig({ api_key: API_KEY });
      writeKey(ed25519Pem());
      server.getRevolutXClient.mockImplementation(() => {
        throw new ConfigurationError(
          'The API URL (REVOLUTX_API_URL) must start with https://. Got "http://x".',
        );
      });

      const text = await call("check_auth_status");

      expect(text).toContain("The API URL (REVOLUTX_API_URL) must start");
      expect(text).toContain("correct the API URL setting");
      expect(text).not.toContain("verify your API key");
      const raw = await client.callTool({
        name: "check_auth_status",
        arguments: {},
      });
      expect(raw.isError).toBeUndefined();
    });

    it.skipIf(!posix)(
      "reports a config others can read as a status, not a failed call",
      async () => {
        writeConfig({ api_key: API_KEY }, 0o644);
        writeKey(ed25519Pem());

        const result = await client.callTool({
          name: "check_auth_status",
          arguments: {},
        });

        expect(getText(result)).toContain("no new key pair is needed");
        expect(result.isError).toBeUndefined();
      },
    );

    it("blames the API key only when the exchange refuses it", async () => {
      writeConfig({ api_key: API_KEY });
      writeKey(ed25519Pem());
      server.getCurrencies.mockRejectedValue(
        new AuthenticationError("Unable to resolve API key"),
      );

      const text = await call("check_auth_status");

      expect(text).toContain("the exchange refused it");
      expect(text).toContain("verify your API key");
    });

    it("says when the exchange can't be reached", async () => {
      writeConfig({ api_key: API_KEY });
      writeKey(ed25519Pem());
      server.getCurrencies.mockRejectedValue(
        new NetworkError("Could not reach the exchange: ENOTFOUND.", {
          mayHaveReachedServer: false,
        }),
      );

      const text = await call("check_auth_status");

      expect(text).toContain("could not be reached");
      expect(text).not.toContain("verify your API key");
    });
  });
});
