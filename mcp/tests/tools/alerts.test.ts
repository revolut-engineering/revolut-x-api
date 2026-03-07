import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMonitorTools } from "../../src/tools/alerts.js";

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerMonitorTools(server);
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

describe("monitor_command tool", () => {
  it("returns correct command for price alert", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "price",
        direction: "above",
        threshold: "100000",
      },
    });
    const text = getText(result);
    expect(text).toContain(
      "revx monitor price BTC-USD --direction above --threshold 100000",
    );
    expect(text).toContain("every 10s");
    expect(text).toContain("Ctrl+C");
  });

  it("includes --interval when custom", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "price",
        direction: "below",
        threshold: "50000",
        interval: 30,
      },
    });
    const text = getText(result);
    expect(text).toContain(
      "revx monitor price BTC-USD --direction below --threshold 50000 --interval 30",
    );
    expect(text).toContain("every 30s");
  });

  it("uses type-specific params for rsi", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "ETH-USD",
        alert_type: "rsi",
        direction: "above",
        threshold: "70",
        period: 14,
      },
    });
    const text = getText(result);
    expect(text).toContain(
      "revx monitor rsi ETH-USD --direction above --threshold 70 --period 14",
    );
  });

  it("uses direction+threshold for rsi without period", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "rsi",
        direction: "above",
        threshold: "70",
      },
    });
    expect(getText(result)).toContain(
      "revx monitor rsi BTC-USD --direction above --threshold 70",
    );
  });

  it("generates ema-cross command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "ema_cross",
        direction: "bullish",
      },
    });
    expect(getText(result)).toContain(
      "revx monitor ema-cross BTC-USD --direction bullish",
    );
  });

  it("generates ema-cross with fast-period and slow-period", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "ema_cross",
        direction: "bullish",
        fast_period: 12,
        slow_period: 26,
      },
    });
    expect(getText(result)).toContain(
      "revx monitor ema-cross BTC-USD --direction bullish --fast-period 12 --slow-period 26",
    );
  });

  it("generates macd command with all params", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "macd",
        direction: "bearish",
        fast: 10,
        slow: 30,
        signal: 7,
      },
    });
    expect(getText(result)).toContain(
      "revx monitor macd BTC-USD --direction bearish --fast 10 --slow 30 --signal 7",
    );
  });

  it("generates bollinger command with band and std-mult", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "ETH-USD",
        alert_type: "bollinger",
        band: "lower",
        period: 30,
        std_mult: 3,
      },
    });
    expect(getText(result)).toContain(
      "revx monitor bollinger ETH-USD --band lower --period 30 --std-mult 3",
    );
  });

  it("generates volume-spike command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "volume_spike",
        period: 30,
        multiplier: 3,
      },
    });
    expect(getText(result)).toContain(
      "revx monitor volume-spike BTC-USD --period 30 --multiplier 3",
    );
  });

  it("generates price-change command with lookback", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "price_change_pct",
        direction: "fall",
        threshold: "10",
        lookback: 48,
      },
    });
    expect(getText(result)).toContain(
      "revx monitor price-change BTC-USD --direction fall --threshold 10 --lookback 48",
    );
  });

  it("generates atr-breakout command", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "atr_breakout",
        period: 20,
        multiplier: 2.5,
      },
    });
    expect(getText(result)).toContain(
      "revx monitor atr-breakout BTC-USD --period 20 --multiplier 2.5",
    );
  });

  it("generates bare command for non-price types with no explicit params", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: { pair: "BTC-USD", alert_type: "rsi" },
    });
    expect(getText(result)).toContain("revx monitor rsi BTC-USD");
  });

  it("rejects missing pair", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: { pair: "" },
    });
    expect(getText(result)).toContain("pair is required");
  });

  it("rejects invalid pair format", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: { pair: "invalid" },
    });
    expect(getText(result)).toContain("Invalid");
  });

  it("rejects unknown alert type", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: { pair: "BTC-USD", alert_type: "foobar" },
    });
    const text = getText(result);
    expect(text).toContain("Unknown alert type");
    expect(text).toContain("foobar");
  });

  it("requires threshold for price alerts", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: { pair: "BTC-USD", alert_type: "price", direction: "above" },
    });
    expect(getText(result)).toContain("threshold is required");
  });

  it("rejects invalid direction for price alerts", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "price",
        direction: "sideways",
        threshold: "100",
      },
    });
    expect(getText(result)).toContain("direction must be");
  });

  it("normalizes pair to uppercase", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "btc-usd",
        alert_type: "price",
        direction: "above",
        threshold: "100000",
      },
    });
    expect(getText(result)).toContain("revx monitor price BTC-USD");
  });

  it("clamps interval to minimum 5", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "price",
        direction: "above",
        threshold: "100000",
        interval: 2,
      },
    });
    expect(getText(result)).toContain("--interval 5");
  });

  it("rejects invalid threshold value", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "price",
        direction: "above",
        threshold: "abc",
      },
    });
    expect(getText(result)).toContain("Invalid threshold");
  });

  it("rejects invalid direction for ema_cross", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_command",
      arguments: {
        pair: "BTC-USD",
        alert_type: "ema_cross",
        direction: "sideways",
      },
    });
    expect(getText(result)).toContain("Invalid direction");
  });
});

describe("monitor_types tool", () => {
  it("returns all 10 monitor types with revx monitor examples", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "monitor_types",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("Supported Monitor Types");
    expect(text).toContain("price");
    expect(text).toContain("rsi");
    expect(text).toContain("ema_cross");
    expect(text).toContain("macd");
    expect(text).toContain("bollinger");
    expect(text).toContain("volume_spike");
    expect(text).toContain("spread");
    expect(text).toContain("obi");
    expect(text).toContain("price_change_pct");
    expect(text).toContain("atr_breakout");
    expect(text).toContain("10 monitor types");
    expect(text).toContain("revx monitor");
    expect(text).toContain("CLI equivalent: revx monitor types");
  });
});
