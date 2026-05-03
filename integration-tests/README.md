# integration-tests — agent eval suite

This package is **not a test suite** in the traditional sense. It's an **evaluation suite with metrics**: runs a real Claude agent against the in-process MCP server multiple times per case, records every prompt / tool-call / response, and judges each case on **pass-rate over N trials** rather than first-failure boolean.

LLMs are non-deterministic; even at `temperature: 0` the agent can occasionally hallucinate a wrong tool, paraphrase awkwardly, or miss a filter. We treat that as a measurement problem, not a flake.

## Two test surfaces

| Folder | Runner | What it covers |
|---|---|---|
| `tests/` | `npm test` (vitest, fast, free) | Pure unit tests of the eval framework itself — `format`, `schemas`, `pricing`, `assertions`, `embeddings` (math + validation), `semantic` (stubbed embedder), `judge` (stubbed Anthropic), `run-eval.aggregate`, `reporter` renderers, `html-report` renderers. No API calls, no model loads. |
| `evals/` | `npm run test:agent` (vitest, calls real LLM) | Agent eval cases — `defineEval({ ... })` files that drive a real Claude agent against the in-process MCP server, persist a full report, and gate on pass-rate. |

`tests/` and `evals/` are deliberately separate folders so the framework's unit tests never get confused with the agent evals they support.

## Quick start

```bash
cp integration-tests/.env.example integration-tests/.env
# edit .env: set ANTHROPIC_API_KEY (and OPENAI_API_KEY if using openai embedder)
npm run test:agent
```

`.env` is loaded automatically by `vitest.config.ts` via `dotenv`. Shell environment variables take precedence over `.env` (`override: false`), so you can still do one-off overrides:

```bash
EVAL_REPETITIONS=5 EVAL_PASS_THRESHOLD=0.8 npm run test:agent
```

`.env` is gitignored at the repo root; commit only `.env.example`.

A run produces:

```
integration-tests/reports/
  index.html                                ← cross-run dashboard (regenerated each run)
  run-2026-04-28T19-24-11/
    metadata.json    ← model, threshold, repetitions, timestamps
    trials.jsonl     ← one line per trial: prompt, full trace, assertion outcomes
    results.jsonl    ← one line per case: aggregated pass-rate, cost, tokens
    summary.json     ← top-level RunReport (CI-friendly)
    junit.xml        ← CI dashboard format
    report.md        ← human-readable digest
    report.html      ← full visual report (open in a browser)
```

Open `integration-tests/reports/index.html` in a browser — it lists every run with pass rate, cost, and a link to the per-run `report.html`. Both pages are self-contained (no server, no build step, dark/light mode auto via `prefers-color-scheme`).

The `reports/` directory is gitignored.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for agent calls + judge assertions |
| `OPENAI_API_KEY` | — | Required only when `EVAL_EMBEDDING_PROVIDER=openai` |
| `EVAL_REPETITIONS` | `3` | Trials per case |
| `EVAL_PASS_THRESHOLD` | `0.667` | Min pass rate (passes/trials) for case to "pass" |
| `EVAL_MODEL` | `claude-opus-4-7` | Agent model |
| `EVAL_JUDGE_MODEL` | `claude-sonnet-4-6` | Model used by `a.judge` assertions |
| `EVAL_JUDGE_MAX_TOKENS` | `512` | Max tokens for judge response |
| `EVAL_EMBEDDING_PROVIDER` | `local` | `local` (transformers.js, no key) or `openai` |
| `EVAL_EMBEDDING_MODEL` | `local` for local provider, `text-embedding-3-small` for openai | Embedding model id |
| `EVAL_RUN_ID` | timestamp | Subdirectory name in `reports/` |
| `EVAL_REPORT_DIR` | `reports/run-<runId>` | Override run directory |
| `EVAL_COST_CAP_USD` | `5` | Logs warning if total run cost exceeds (agent + judge + embed) |
| `EVAL_LOG_LEVEL` | `info` | `silent` / `warn` / `info` / `debug` — controls framework-internal logging |
| `EVAL_STRICT` | `false` | When truthy (`1` / `true` / `yes` / `on`), failing eval cases call `expect.fail` and the run exits non-zero. Default is lenient — failures are logged loudly to stderr and persisted in `summary.json`/`report.html`, but the run exits 0. Use strict mode for CI gates that should block on threshold misses. |

Examples:

```bash
EVAL_REPETITIONS=5 EVAL_PASS_THRESHOLD=0.8 npm run test:agent          # stricter
EVAL_REPETITIONS=1 npm run test:agent -- -t "get-balances"             # quick check
EVAL_MODEL=claude-haiku-4-5 npm run test:agent                         # cheap floor test
```

## Assertion types

Three kinds. All return objects from the `a` namespace and slot into `assertions: [...]`.

### 1. Predicate (boolean checks against the trial context)

The `a` helpers cover common patterns:

```ts
a.callsTool("get_balances")
a.doesNotCallTool("cancel_all_orders")
a.callsToolWithArgs("get_active_orders", { symbols: ["BTC-USD"] })
a.callsToolNTimes("get_tickers", 1)
a.callsExactly(["get_balances", "get_tickers"])              // multiset
a.callsInOrder(["get_balances", "get_tickers"])              // subsequence
a.callsExactlyInOrder(["get_balances", "get_tickers"])       // strict
a.finalTextMatches(/95[,.]?0\d\d/)
a.finalTextContainsAll(["BTC", "USD"])
a.endsTurn()
a.withinTokenBudget(2000)
a.withinLatency(15_000)
```

For anything not covered, drop to a raw predicate:

```ts
{ name: "agent did not invent a tool",
  check: ({ toolCalls }) => toolCalls.every(c => KNOWN_TOOLS.has(c.name)) }
```

### 2. LLM-as-judge (graded by a second model)

```ts
a.judge({
  name: "answer correctly summarizes both balances and BTC price",
  criterion:
    "The answer accurately reports the user's BTC and USD balances and the BTC price. It is concise and free of hallucinated values.",
  threshold: 0.8,                  // default 0.7
  model: "claude-sonnet-4-6",      // default — overridable per-assertion or via EVAL_JUDGE_MODEL
})
```

The judge sees the user prompt, the tool calls (with args), and the agent's final answer. It returns a score 0–1 plus reasoning, both persisted in the trial record. The assertion passes when `score >= threshold`. Use a structured `rubric` field to anchor scoring if needed.

### 3. Semantic similarity (embedding cosine vs. reference)

```ts
a.semanticallyMatches({
  name: "answer is semantically close to ideal snapshot",
  reference: "You hold 1.5 BTC and 10,000 USD. Bitcoin is around $95,050.",
  threshold: 0.7,
})

a.semanticallyMatchesAny({
  name: "answer expresses 'no orders'",
  references: ["You have no active orders.", "Your order list is empty."],
  threshold: 0.65,
})

a.semanticallyMatchesAvg({
  name: "answer covers a range of expected points",
  references: ["BTC price", "USD balance", "BTC balance"],
  threshold: 0.5,
})
```

Embeds the agent's final text and the reference(s), computes cosine similarity. `MatchesAny` passes if **any** reference is above threshold; `MatchesAvg` passes if the **average** similarity is above threshold.

**Embedder providers** — pick via `EVAL_EMBEDDING_PROVIDER`:
- `local` (default) — `@xenova/transformers` running `Xenova/all-MiniLM-L6-v2` in-process. No extra key, ~30MB downloaded on first run, ~2s cold start, free.
- `openai` — `text-embedding-3-small` via the OpenAI API. Requires `OPENAI_API_KEY`. ~$0.02 per 1M tokens.

Both implement the same `Embedder` interface in `src/eval-framework/embeddings.ts` — drop in Voyage etc. by adding a class.

## How a case is judged

1. Framework runs `setup` → `harness.runAgent({prompt})` → evaluates each assertion. Repeats N times.
2. Trial `passes` iff every assertion is true.
3. Case `passes` iff `passes / trials ≥ EVAL_PASS_THRESHOLD`.
4. Vitest reports the case failed only if the threshold isn't met. Individual trial flakes do NOT fail the case.

## Reading the reports

**`reports/index.html`** — entry point. All runs to date, sorted newest first. Click a run to drill into its `report.html`.

**`report.html`** — per-run visual report. Cases table (sortable, filterable), per-case detail with assertion bars and trial-by-trial drill-down (tool calls, final text, per-assertion outcomes with judge reasoning / semantic scores).

**`report.md`** — same data as `report.html`, plain markdown for terminal/diff use.

**`summary.json`** — same data structured for CI. `RunReport` shape:

## Metrics tracked

| Metric | Granularity | Source |
|---|---|---|
| Pass rate | per case + per assertion + per run | trial outcomes |
| Cost (USD) | per trial + per case + per run | `usage` × `pricing.ts` |
| Tokens (in/out/cache) | per trial + per case + per run | Anthropic `response.usage` |
| Latency (ms) | per trial + per case + per run | wall clock |
| Tool calls | per trial | recorded in `runAgent` loop |
| Turns to `end_turn` | per trial | loop iteration count |
