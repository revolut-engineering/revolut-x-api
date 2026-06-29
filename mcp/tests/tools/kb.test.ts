import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerKbTools, INTENT_MAP, INTENT_KEYS } from "../../src/tools/kb.js";
import { SERVER_INSTRUCTIONS } from "../../src/server.js";

vi.mock("../../src/server.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/server.js")>();
  return { ...mod };
});

function getText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  return r.content.map((c) => c.text).join("\n");
}

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerKbTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

// ─── Hallucination prevention ────────────────────────────────────────────────
// Each article must contain the specific factual claims it is supposed to make.
// A test failure here means the source article was changed to drop or contradict
// a known fact, which the agent would then silently stop surfacing.

const FACTUAL_ASSERTIONS: Array<{ intent: string; facts: string[] }> = [
  {
    intent: "fees",
    facts: ["1 GBP", "3 GBP", "network fee", "XRP"],
  },
  {
    intent: "get_started",
    facts: ["18 years old", "government-issued ID"],
  },
  {
    intent: "order_types",
    facts: ["market order", "limit order", "TWAP", "TP/SL"],
  },
  {
    intent: "failed_orders",
    facts: ["slippage protection", "self-matching protection", "liquidity"],
  },
  {
    intent: "locked_balance",
    facts: ["locked", "pending", "cancel"],
  },
  {
    intent: "deposits_withdrawals",
    facts: ["Deposit", "Withdrawal"],
  },
  {
    intent: "unified_balance",
    facts: ["unified", "migration", "statement"],
  },
  {
    intent: "cant_trade",
    facts: ["maintenance", "insufficient"],
  },
  {
    intent: "crypto_safety",
    facts: ["cold storage", "multi-signature", "custodian"],
  },
  {
    intent: "crypto_provider",
    facts: ["FRN 900562", "Financial Services Compensation Scheme"],
  },
  {
    intent: "legal_links",
    facts: [
      "crypto-exchange-trading-rules",
      "crypto-exchange-fees",
      "crypto-exchange-terms",
    ],
  },
];

describe("search_kb — hallucination prevention", () => {
  let client: Client;
  beforeAll(async () => {
    client = await createClient();
  });

  it.each(FACTUAL_ASSERTIONS)(
    "$intent article contains its required facts",
    async ({ intent, facts }) => {
      const result = await client.callTool({
        name: "search_kb",
        arguments: { intent },
      });
      const text = getText(result).toLowerCase();
      for (const fact of facts) {
        expect(text, `"${fact}" missing from ${intent} article`).toContain(
          fact.toLowerCase(),
        );
      }
    },
  );
});

// ─── Poor precision prevention ───────────────────────────────────────────────
// Each article's content must be specifically about its stated intent.
// A test failure here means either the wrong article is mapped to an intent, or
// the article is too generic to be useful for that intent.

const PRECISION_CHECKS: Array<{ intent: string; topicTerms: string[] }> = [
  { intent: "fees", topicTerms: ["fee", "GBP", "withdrawal"] },
  { intent: "get_started", topicTerms: ["sign up", "account", "Revolut X"] },
  { intent: "order_types", topicTerms: ["order", "market", "limit"] },
  { intent: "failed_orders", topicTerms: ["cancelled", "rejected", "failed"] },
  { intent: "locked_balance", topicTerms: ["locked", "unavailable", "balance"] },
  { intent: "deposits_withdrawals", topicTerms: ["deposit", "withdraw", "fund"] },
  { intent: "unified_balance", topicTerms: ["unified", "balance", "Revolut X"] },
  { intent: "cant_trade", topicTerms: ["trade", "order", "maintenance"] },
  { intent: "crypto_safety", topicTerms: ["crypto", "safe", "storage"] },
  {
    intent: "crypto_provider",
    topicTerms: ["crypto", "service", "Revolut"],
  },
  {
    intent: "legal_links",
    topicTerms: ["legal", "trading rules", "terms"],
  },
];

describe("search_kb — precision (article covers its intent)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await createClient();
  });

  it.each(PRECISION_CHECKS)(
    "$intent article is specifically about its topic",
    async ({ intent, topicTerms }) => {
      const result = await client.callTool({
        name: "search_kb",
        arguments: { intent },
      });
      const text = getText(result).toLowerCase();
      const matched = topicTerms.filter((t) => text.includes(t.toLowerCase()));
      expect(
        matched.length,
        `${intent} article only matched ${matched.length}/${topicTerms.length} topic terms`,
      ).toBeGreaterThanOrEqual(Math.ceil(topicTerms.length * 0.6));
    },
  );
});

// ─── Poor recall prevention ───────────────────────────────────────────────────
// Every major user question category must have a matching intent, and each
// intent description must be specific enough for an LLM to correctly route
// common phrasings to it. A test failure here means a topic is uncovered or an
// intent description is too vague to reliably trigger.

// (query, expectedIntent): the expectedIntent's description must share meaningful
// keywords with the query — a proxy for LLM classification accuracy without
// requiring a live model call.
const EVAL_CASES: Array<{ query: string; expectedIntent: string }> = [
  { query: "How do I sign up for Revolut X?", expectedIntent: "get_started" },
  { query: "What are the trading fees on Revolut X?", expectedIntent: "fees" },
  { query: "How does a stop loss order work?", expectedIntent: "order_types" },
  { query: "My order was cancelled, why?", expectedIntent: "failed_orders" },
  { query: "Part of my balance is locked", expectedIntent: "locked_balance" },
  { query: "How do I add funds to my account?", expectedIntent: "deposits_withdrawals" },
  {
    query: "What happened to my crypto after the balance migration?",
    expectedIntent: "unified_balance",
  },
  { query: "I cannot place trades on Revolut X", expectedIntent: "cant_trade" },
  { query: "Is my crypto stored safely?", expectedIntent: "crypto_safety" },
  { query: "Who provides Revolut crypto services in the UK?", expectedIntent: "crypto_provider" },
  { query: "Where can I find the Revolut X terms and conditions?", expectedIntent: "legal_links" },
];

describe("search_kb — recall (intent coverage)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await createClient();
  });

  it("every intent returns non-empty article content", async () => {
    for (const intent of INTENT_KEYS) {
      const result = await client.callTool({
        name: "search_kb",
        arguments: { intent },
      });
      expect(
        getText(result).length,
        `${intent} returned empty content`,
      ).toBeGreaterThan(100);
    }
  });

  it("list_kb_articles covers all intents", async () => {
    const result = await client.callTool({
      name: "list_kb_articles",
      arguments: {},
    });
    const text = getText(result);
    for (const intent of INTENT_KEYS) {
      expect(text, `${intent} missing from list_kb_articles`).toContain(intent);
    }
  });

  it.each(EVAL_CASES)(
    'query "$query" has intent description overlap with $expectedIntent',
    ({ query, expectedIntent }) => {
      const entry = INTENT_MAP[expectedIntent];
      expect(entry, `intent "${expectedIntent}" not found in INTENT_MAP`).toBeDefined();

      const queryWords = new Set(
        query.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
      );
      const descWords = new Set(
        entry.description.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
      );
      const overlap = [...queryWords].filter((w) => descWords.has(w));
      expect(
        overlap.length,
        `No keyword overlap between query and "${expectedIntent}" description — description may be too vague to route this query correctly`,
      ).toBeGreaterThanOrEqual(1);
    },
  );
});

// ─── Ungrounded claims prevention ────────────────────────────────────────────
// The server instructions must mandate that the agent consults the KB before
// answering any question about platform features. If these rules are weakened or
// removed, the agent is free to answer from training data, which is the primary
// vector for ungrounded claims.

describe("search_kb — ungrounded claims prevention", () => {
  it("server instructions forbid answering platform questions from training data", () => {
    expect(SERVER_INSTRUCTIONS).toContain("search_kb");
    expect(SERVER_INSTRUCTIONS).toContain("MUST come from");
    expect(SERVER_INSTRUCTIONS).toContain("training data");
  });

  it("server instructions cover the main KB topics", () => {
    const topics = [
      "fees",
      "order types",
      "deposits",
      "withdrawals",
      "account",
      "platform features",
    ];
    const lower = SERVER_INSTRUCTIONS.toLowerCase();
    for (const topic of topics) {
      expect(lower, `server instructions don't mention "${topic}"`).toContain(topic);
    }
  });

  it("search_kb always returns article content, never generated text", async () => {
    const client = await createClient();
    for (const intent of INTENT_KEYS) {
      const result = await client.callTool({
        name: "search_kb",
        arguments: { intent },
      });
      const text = getText(result);
      // Content must start with a markdown heading from the source article,
      // not a generated preamble like "Here is the article..." or "Based on..."
      expect(
        text.trimStart(),
        `${intent} content does not start with a markdown heading`,
      ).toMatch(/^#/);
    }
  });
});
