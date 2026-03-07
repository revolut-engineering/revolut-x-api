import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTelegramTools } from "../../src/tools/telegram.js";

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTelegramTools(server);
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

describe("telegram_command tool", () => {
  it("add returns CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "add", bot_token: "123:ABC", chat_id: "456" },
    });
    const text = getText(result);
    expect(text).toContain("revx telegram add");
    expect(text).toContain("--token 123:ABC");
    expect(text).toContain("--chat-id 456");
  });

  it("add includes label", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: {
        action: "add",
        bot_token: "123:ABC",
        chat_id: "456",
        label: "mybot",
      },
    });
    expect(getText(result)).toContain("--label");
    expect(getText(result)).toContain("mybot");
  });

  it("add includes --test flag", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: {
        action: "add",
        bot_token: "123:ABC",
        chat_id: "456",
        test_on_add: true,
      },
    });
    expect(getText(result)).toContain("--test");
  });

  it("add requires bot_token", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "add", chat_id: "456" },
    });
    expect(getText(result)).toContain("Missing required parameter: bot_token");
  });

  it("add requires chat_id", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "add", bot_token: "123:ABC" },
    });
    expect(getText(result)).toContain("Missing required parameter: chat_id");
  });

  it("list returns CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "list" },
    });
    const text = getText(result);
    expect(text).toContain("revx telegram list");
    expect(text).toContain("--json");
  });

  it("delete requires connection_id", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "delete" },
    });
    expect(getText(result)).toContain(
      "Missing required parameter: connection_id",
    );
  });

  it("delete returns CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "delete", connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("revx telegram delete conn-1");
  });

  it("enable returns CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "enable", connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("revx telegram enable conn-1");
  });

  it("disable returns CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "disable", connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("revx telegram disable conn-1");
  });

  it("test returns CLI command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: { action: "test", connection_id: "conn-1" },
    });
    expect(getText(result)).toContain("revx telegram test conn-1");
  });

  it("test includes custom message", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "telegram_command",
      arguments: {
        action: "test",
        connection_id: "conn-1",
        message: "Hello world",
      },
    });
    const text = getText(result);
    expect(text).toContain("--message");
    expect(text).toContain("Hello world");
  });
});
