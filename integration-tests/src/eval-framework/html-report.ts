import type {
  AssertionOutcome,
  EvalResult,
  RunReport,
  TrialResult,
} from "./types.js";
import { fmt } from "./format.js";

export interface RunIndexEntry {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  model: string;
  judgeModel: string;
  embeddingProvider: string;
  passed: number;
  total: number;
  totalCost: number;
  durationMs: number;
  reportPath: string;
}

export function renderRunHtml(report: RunReport): string {
  const meta = report.metadata;
  const grand =
    report.totalCost + report.totalJudgeCost + report.totalEmbeddingCost;
  const overallPct = report.totalCases
    ? (report.passed / report.totalCases) * 100
    : 0;

  return [
    "<!DOCTYPE html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>Eval run ${escapeHtml(meta.runId)}</title>`,
    `<style>${renderStyles()}</style>`,
    "</head>",
    "<body>",
    `<a class="back-link" href="../index.html">&larr; All runs</a>`,
    renderHeader(report, grand, overallPct),
    renderToolbar(),
    renderCasesTable(report),
    `<section class="cases">${report.results.map(renderCaseSection).join("\n")}</section>`,
    `<script>${renderScript()}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function renderIndexHtml(runs: RunIndexEntry[]): string {
  const sorted = [...runs].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const totalCost = sorted.reduce((sum, r) => sum + r.totalCost, 0);
  const totalCases = sorted.reduce((sum, r) => sum + r.total, 0);
  const totalPassed = sorted.reduce((sum, r) => sum + r.passed, 0);

  return [
    "<!DOCTYPE html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>Eval runs</title>`,
    `<style>${renderStyles()}</style>`,
    "</head>",
    "<body>",
    `<header class="header">`,
    `  <div class="header-row">`,
    `    <h1>Eval runs</h1>`,
    `    <div class="totals">`,
    `      <div class="total-block"><div class="total-label">Runs</div><div class="total-value">${sorted.length}</div></div>`,
    `      <div class="total-block"><div class="total-label">Cases passed</div><div class="total-value">${totalPassed}/${totalCases}</div></div>`,
    `      <div class="total-block"><div class="total-label">Total cost</div><div class="total-value">${fmt.cost(totalCost)}</div></div>`,
    `    </div>`,
    `  </div>`,
    `</header>`,
    `<main>`,
    sorted.length === 0
      ? `<p class="empty">No runs yet. Run <code>npm run test:agent</code> to produce one.</p>`
      : renderIndexTable(sorted),
    `</main>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderHeader(
  report: RunReport,
  grand: number,
  overallPct: number,
): string {
  const meta = report.metadata;
  const overallClass =
    overallPct >= 100 ? "pass" : overallPct >= 50 ? "warn" : "fail";
  return [
    `<header class="header">`,
    `  <div class="header-row">`,
    `    <div>`,
    `      <h1>Eval run <code>${escapeHtml(meta.runId)}</code></h1>`,
    `      <dl class="meta">`,
    `        <dt>Agent</dt><dd><code>${escapeHtml(meta.model)}</code></dd>`,
    `        <dt>Judge</dt><dd><code>${escapeHtml(meta.judgeModel)}</code></dd>`,
    `        <dt>Embedder</dt><dd><code>${escapeHtml(meta.embeddingProvider)}/${escapeHtml(meta.embeddingModel)}</code></dd>`,
    `        <dt>Repetitions</dt><dd>${meta.repetitions} · threshold ${fmt.threshold(meta.passThreshold)}</dd>`,
    `        <dt>Started</dt><dd>${escapeHtml(fmt.timestamp(meta.startedAt))}</dd>`,
    meta.finishedAt
      ? `        <dt>Finished</dt><dd>${escapeHtml(fmt.timestamp(meta.finishedAt))}</dd>`
      : "",
    `        <dt>Duration</dt><dd>${fmt.durationMs(report.totalDurationMs)}</dd>`,
    `      </dl>`,
    `    </div>`,
    `    <div class="totals">`,
    `      <div class="total-block ${overallClass}"><div class="total-label">Cases passed</div><div class="total-value">${report.passed}/${report.totalCases}</div></div>`,
    `      <div class="total-block"><div class="total-label">Total cost</div><div class="total-value">${fmt.cost(grand)}</div></div>`,
    `      <div class="total-block"><div class="total-label">Agent / judge / embed</div><div class="total-value cost-split">${fmt.cost(report.totalCost)} · ${fmt.cost(report.totalJudgeCost)} · ${fmt.cost(report.totalEmbeddingCost)}</div></div>`,
    `    </div>`,
    `  </div>`,
    `</header>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderToolbar(): string {
  return [
    `<div class="toolbar">`,
    `  <input id="filter" type="search" placeholder="Filter by case name..." aria-label="Filter cases">`,
    `  <button type="button" data-action="expand-all">Expand all</button>`,
    `  <button type="button" data-action="collapse-all">Collapse all</button>`,
    `</div>`,
  ].join("\n");
}

function renderCasesTable(report: RunReport): string {
  const rows = report.results
    .map((r) => {
      const avgLatency =
        r.trials.length === 0
          ? 0
          : r.trials.reduce((s, t) => s + t.durationMs, 0) / r.trials.length;
      const passPct = r.passRate * 100;
      const passClass = r.passed ? "pass" : "fail";
      const anchor = caseAnchor(r.name);
      return [
        `    <tr data-case="${escapeAttr(r.name)}">`,
        `      <td><span class="pill ${passClass}">${r.passed ? "PASS" : "FAIL"}</span></td>`,
        `      <td><a href="#${escapeAttr(anchor)}"><code>${escapeHtml(r.name)}</code></a></td>`,
        `      <td data-sort-value="${r.passRate.toFixed(4)}">${renderRateBar(r.passes, r.trialCount, passPct, passClass)}</td>`,
        `      <td data-sort-value="${r.totalCost.toFixed(6)}">${fmt.cost(r.totalCost)}</td>`,
        `      <td data-sort-value="${r.totalJudgeCost.toFixed(6)}">${fmt.cost(r.totalJudgeCost)}</td>`,
        `      <td data-sort-value="${r.totalEmbeddingCost.toFixed(6)}">${fmt.cost(r.totalEmbeddingCost)}</td>`,
        `      <td data-sort-value="${avgLatency.toFixed(0)}">${fmt.durationMs(avgLatency)}</td>`,
        `      <td>${fmt.tokens(r.totalInputTokens, r.totalOutputTokens)}</td>`,
        `    </tr>`,
      ].join("\n");
    })
    .join("\n");

  return [
    `<section class="cases-table-wrapper">`,
    `  <h2>Cases</h2>`,
    `  <table class="cases-table" id="cases-table">`,
    `    <thead>`,
    `      <tr>`,
    `        <th data-sortable="true" data-sort-type="text">Status</th>`,
    `        <th data-sortable="true" data-sort-type="text">Case</th>`,
    `        <th data-sortable="true" data-sort-type="number">Pass rate</th>`,
    `        <th data-sortable="true" data-sort-type="number">Agent $</th>`,
    `        <th data-sortable="true" data-sort-type="number">Judge $</th>`,
    `        <th data-sortable="true" data-sort-type="number">Embed $</th>`,
    `        <th data-sortable="true" data-sort-type="number">Avg latency</th>`,
    `        <th>Tokens (in/out)</th>`,
    `      </tr>`,
    `    </thead>`,
    `    <tbody>`,
    rows,
    `    </tbody>`,
    `  </table>`,
    `</section>`,
  ].join("\n");
}

function renderIndexTable(runs: RunIndexEntry[]): string {
  const rows = runs
    .map((r) => {
      const passPct = r.total === 0 ? 0 : (r.passed / r.total) * 100;
      const passClass = r.total > 0 && r.passed === r.total ? "pass" : "fail";
      return [
        `    <tr>`,
        `      <td><span class="pill ${passClass}">${passClass.toUpperCase()}</span></td>`,
        `      <td><a href="${escapeAttr(r.reportPath)}"><code>${escapeHtml(r.runId)}</code></a></td>`,
        `      <td>${escapeHtml(fmt.timestamp(r.startedAt))}</td>`,
        `      <td><code>${escapeHtml(r.model)}</code></td>`,
        `      <td>${renderRateBar(r.passed, r.total, passPct, passClass)}</td>`,
        `      <td>${fmt.cost(r.totalCost)}</td>`,
        `      <td>${fmt.durationMs(r.durationMs)}</td>`,
        `    </tr>`,
      ].join("\n");
    })
    .join("\n");

  return [
    `<section class="cases-table-wrapper">`,
    `  <table class="cases-table">`,
    `    <thead>`,
    `      <tr>`,
    `        <th>Status</th>`,
    `        <th>Run id</th>`,
    `        <th>Started</th>`,
    `        <th>Model</th>`,
    `        <th>Pass rate</th>`,
    `        <th>Cost</th>`,
    `        <th>Duration</th>`,
    `      </tr>`,
    `    </thead>`,
    `    <tbody>`,
    rows,
    `    </tbody>`,
    `  </table>`,
    `</section>`,
  ].join("\n");
}

function renderRateBar(
  numerator: number,
  denominator: number,
  pct: number,
  cls: string,
): string {
  const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return [
    `<div class="rate">`,
    `  <span class="rate-text">${numerator}/${denominator} <span class="rate-pct">${safePct.toFixed(0)}%</span></span>`,
    `  <div class="bar"><div class="bar-fill ${cls}" style="width:${safePct.toFixed(1)}%"></div></div>`,
    `</div>`,
  ].join("");
}

function renderCaseSection(result: EvalResult): string {
  const anchor = caseAnchor(result.name);
  return [
    `<article class="case" data-case="${escapeAttr(result.name)}" id="${escapeAttr(anchor)}">`,
    `  <header class="case-header">`,
    `    <span class="pill ${result.passed ? "pass" : "fail"}">${result.passed ? "PASS" : "FAIL"}</span>`,
    `    <h2><code>${escapeHtml(result.name)}</code></h2>`,
    `    <span class="case-meta">${result.passes}/${result.trialCount} (${fmt.pct(result.passRate)}) · threshold ${fmt.threshold(result.threshold)} · ${fmt.cost(result.totalCost + result.totalJudgeCost + result.totalEmbeddingCost)}</span>`,
    `  </header>`,
    result.description
      ? `  <p class="case-description">${escapeHtml(result.description)}</p>`
      : "",
    `  <details class="prompt-block"><summary>Prompt</summary><pre>${escapeHtml(result.prompt)}</pre></details>`,
    renderAssertionSummary(result),
    renderTrials(result.trials),
    `</article>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderAssertionSummary(result: EvalResult): string {
  const items = Object.entries(result.assertionPassRates)
    .map(([name, rate]) => {
      const score = result.assertionMeanScores[name];
      const pct = rate * 100;
      const cls = rate >= result.threshold ? "pass" : "fail";
      const scorePart =
        typeof score === "number"
          ? ` <span class="score">mean score ${fmt.score(score)}</span>`
          : "";
      return [
        `<li>`,
        `  <div class="assertion-name">${escapeHtml(name)}${scorePart}</div>`,
        `  ${renderRateBar(Math.round(rate * result.trialCount), result.trialCount, pct, cls)}`,
        `</li>`,
      ].join("");
    })
    .join("\n");
  return [
    `  <section class="assertions-summary">`,
    `    <h3>Per-assertion pass rates</h3>`,
    `    <ul>${items}</ul>`,
    `  </section>`,
  ].join("\n");
}

function renderTrials(trials: TrialResult[]): string {
  const items = trials.map(renderTrial).join("\n");
  return [
    `  <section class="trials">`,
    `    <h3>Trials</h3>`,
    items,
    `  </section>`,
  ].join("\n");
}

function renderTrial(trial: TrialResult): string {
  const totalCost = trial.cost + trial.judgeCost + trial.embeddingCost;
  const cls = trial.passed ? "pass" : "fail";
  const summary = [
    `<span class="pill ${cls}">${trial.passed ? "PASS" : "FAIL"}</span>`,
    `Trial ${trial.trial}`,
    `<span class="trial-meta">${fmt.durationMs(trial.durationMs)} · ${fmt.cost(totalCost)} · ${trial.agent.turns} turn(s) · ${fmt.tokens(trial.agent.usage.inputTokens, trial.agent.usage.outputTokens)} tok</span>`,
  ].join(" ");

  return [
    `    <details class="trial">`,
    `      <summary>${summary}</summary>`,
    trial.error
      ? `      <div class="trial-error"><h4>Error</h4><pre>${escapeHtml(trial.error)}</pre></div>`
      : "",
    renderToolCalls(trial),
    renderFinalText(trial),
    renderTrialAssertions(trial.assertions),
    `    </details>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderToolCalls(trial: TrialResult): string {
  if (trial.agent.toolCalls.length === 0) {
    return `      <div class="trial-section"><h4>Tool calls</h4><p class="muted">none</p></div>`;
  }
  const items = trial.agent.toolCalls
    .map(
      (c) =>
        `<li><code>${escapeHtml(c.name)}</code> <span class="muted">turn ${c.turn}</span><pre class="args">${escapeHtml(JSON.stringify(c.args, null, 2))}</pre></li>`,
    )
    .join("\n");
  return [
    `      <div class="trial-section">`,
    `        <h4>Tool calls (${trial.agent.toolCalls.length})</h4>`,
    `        <ol class="tool-calls">${items}</ol>`,
    `      </div>`,
  ].join("\n");
}

function renderFinalText(trial: TrialResult): string {
  if (!trial.agent.finalText) return "";
  const text = trial.agent.finalText;
  if (text.length <= 800) {
    return [
      `      <div class="trial-section">`,
      `        <h4>Final text <span class="muted">(stop: ${escapeHtml(trial.agent.stopReason)})</span></h4>`,
      `        <pre class="final-text">${escapeHtml(text)}</pre>`,
      `      </div>`,
    ].join("\n");
  }
  return [
    `      <div class="trial-section">`,
    `        <h4>Final text <span class="muted">(stop: ${escapeHtml(trial.agent.stopReason)})</span></h4>`,
    `        <details><summary>${text.length} characters &mdash; show</summary><pre class="final-text">${escapeHtml(text)}</pre></details>`,
    `      </div>`,
  ].join("\n");
}

function renderTrialAssertions(outcomes: AssertionOutcome[]): string {
  if (outcomes.length === 0) return "";
  const items = outcomes
    .map((a) => {
      const cls = a.passed ? "pass" : "fail";
      const numericScore = a.kind === "predicate" ? undefined : a.score;
      const score =
        typeof numericScore === "number"
          ? ` <span class="score">${numericScore.toFixed(3)}</span>`
          : "";
      const reasoningText = a.kind === "predicate" ? undefined : a.reasoning;
      const reasoning = reasoningText
        ? `<div class="reasoning">${escapeHtml(reasoningText)}</div>`
        : "";
      const error = a.error
        ? `<div class="reasoning error">${escapeHtml(a.error)}</div>`
        : "";
      const kind = `<span class="kind kind-${a.kind}">${a.kind}</span>`;
      return [
        `<li class="trial-assertion">`,
        `  <div class="trial-assertion-row"><span class="pill ${cls}">${a.passed ? "PASS" : "FAIL"}</span> ${kind} ${escapeHtml(a.name)}${score}</div>`,
        reasoning,
        error,
        `</li>`,
      ].join("");
    })
    .join("\n");
  return [
    `      <div class="trial-section">`,
    `        <h4>Assertions</h4>`,
    `        <ul class="trial-assertions">${items}</ul>`,
    `      </div>`,
  ].join("\n");
}

function caseAnchor(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}

function renderStyles(): string {
  return `
    :root {
      --bg: #fafafa;
      --fg: #1a1a1a;
      --muted: #6b7280;
      --border: #e5e7eb;
      --card: #ffffff;
      --code-bg: #f3f4f6;
      --pass-bg: #d1fae5;
      --pass-fg: #065f46;
      --fail-bg: #fee2e2;
      --fail-fg: #991b1b;
      --warn-bg: #fef3c7;
      --warn-fg: #92400e;
      --bar-track: #e5e7eb;
      --bar-pass: #10b981;
      --bar-fail: #ef4444;
      --link: #2563eb;
      --kind-predicate: #6366f1;
      --kind-judge: #d97706;
      --kind-semantic: #0891b2;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --fg: #e2e8f0;
        --muted: #94a3b8;
        --border: #1e293b;
        --card: #1e293b;
        --code-bg: #0f172a;
        --pass-bg: #064e3b;
        --pass-fg: #6ee7b7;
        --fail-bg: #7f1d1d;
        --fail-fg: #fca5a5;
        --warn-bg: #78350f;
        --warn-fg: #fcd34d;
        --bar-track: #334155;
        --bar-pass: #34d399;
        --bar-fail: #f87171;
        --link: #60a5fa;
        --kind-predicate: #818cf8;
        --kind-judge: #fbbf24;
        --kind-semantic: #22d3ee;
      }
    }
    * { box-sizing: border-box; }
    html { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; line-height: 1.5; }
    body { margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg); max-width: 1400px; margin: 0 auto; }
    h1, h2, h3, h4 { margin: 0; line-height: 1.2; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-bottom: 0.75rem; }
    h3 { font-size: 1rem; margin: 1rem 0 0.5rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    h4 { font-size: 0.85rem; margin: 0.75rem 0 0.25rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: "SF Mono", Monaco, Menlo, Consolas, monospace; font-size: 0.9em; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 0.25rem; }
    pre { font-family: "SF Mono", Monaco, Menlo, Consolas, monospace; font-size: 0.85rem; background: var(--code-bg); padding: 0.75rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.5rem 0; white-space: pre-wrap; word-break: break-word; }
    pre code { background: none; padding: 0; }
    .back-link { display: inline-block; margin-bottom: 1rem; color: var(--muted); }
    .header { background: var(--card); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1.25rem; }
    .header-row { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 1rem; align-items: flex-start; }
    .meta { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; margin: 0.5rem 0 0; font-size: 0.9rem; }
    .meta dt { color: var(--muted); }
    .meta dd { margin: 0; }
    .totals { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    .total-block { background: var(--code-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.5rem 0.75rem; min-width: 8rem; }
    .total-block.pass { border-color: var(--bar-pass); }
    .total-block.fail { border-color: var(--bar-fail); }
    .total-block.warn { border-color: var(--warn-fg); }
    .total-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .total-value { font-size: 1.25rem; font-weight: 600; }
    .cost-split { font-size: 0.85rem; }
    .toolbar { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; align-items: center; }
    .toolbar input { flex: 1; min-width: 12rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--card); color: var(--fg); font: inherit; }
    .toolbar button { padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--card); color: var(--fg); font: inherit; cursor: pointer; }
    .toolbar button:hover { background: var(--code-bg); }
    .cases-table-wrapper { background: var(--card); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.25rem; overflow-x: auto; }
    .cases-table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    .cases-table th, .cases-table td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .cases-table th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; user-select: none; }
    .cases-table th[data-sortable="true"]:hover { color: var(--fg); }
    .cases-table tbody tr:hover { background: var(--code-bg); }
    .cases-table tbody tr:last-child td { border-bottom: none; }
    .pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.05em; }
    .pill.pass { background: var(--pass-bg); color: var(--pass-fg); }
    .pill.fail { background: var(--fail-bg); color: var(--fail-fg); }
    .rate { display: flex; align-items: center; gap: 0.5rem; min-width: 12rem; }
    .rate-text { white-space: nowrap; font-variant-numeric: tabular-nums; min-width: 5rem; }
    .rate-pct { color: var(--muted); }
    .bar { flex: 1; height: 0.4rem; background: var(--bar-track); border-radius: 999px; overflow: hidden; min-width: 4rem; }
    .bar-fill { height: 100%; transition: width 0.3s; }
    .bar-fill.pass { background: var(--bar-pass); }
    .bar-fill.fail { background: var(--bar-fail); }
    .case { background: var(--card); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1rem; }
    .case-header { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .case-header h2 { flex: 1; min-width: 0; }
    .case-meta { font-size: 0.85rem; color: var(--muted); }
    .case-description { color: var(--muted); margin: 0.25rem 0 0.75rem; }
    .prompt-block summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; padding: 0.25rem 0; }
    .prompt-block[open] summary { margin-bottom: 0.5rem; }
    .assertions-summary ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
    .assertions-summary li { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem 1rem; align-items: center; }
    .assertion-name { font-size: 0.9rem; }
    .score { display: inline-block; margin-left: 0.5rem; padding: 0 0.4rem; background: var(--code-bg); border-radius: 0.25rem; font-size: 0.75rem; color: var(--muted); }
    .trials { display: grid; gap: 0.5rem; }
    .trial { background: var(--code-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.5rem 0.75rem; }
    .trial summary { cursor: pointer; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.9rem; }
    .trial[open] summary { margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
    .trial-meta { color: var(--muted); font-size: 0.85rem; }
    .trial-section { margin: 0.75rem 0; }
    .trial-section h4 { margin: 0 0 0.25rem; }
    .tool-calls { padding-left: 1.5rem; margin: 0; }
    .tool-calls li { margin: 0.25rem 0; }
    .args { margin: 0.25rem 0 0.5rem; font-size: 0.8rem; }
    .final-text { margin-top: 0.25rem; }
    .trial-assertions { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
    .trial-assertion-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.9rem; }
    .reasoning { margin: 0.25rem 0 0 0.5rem; padding: 0.4rem 0.6rem; border-left: 2px solid var(--border); background: var(--code-bg); border-radius: 0 0.25rem 0.25rem 0; font-size: 0.85rem; color: var(--muted); white-space: pre-wrap; }
    .reasoning.error { color: var(--fail-fg); border-left-color: var(--bar-fail); }
    .trial-error { background: var(--fail-bg); color: var(--fail-fg); padding: 0.5rem 0.75rem; border-radius: 0.5rem; margin: 0.5rem 0; }
    .trial-error h4 { color: var(--fail-fg); margin-top: 0; }
    .kind { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 0.25rem; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: var(--code-bg); }
    .kind-predicate { color: var(--kind-predicate); }
    .kind-judge { color: var(--kind-judge); }
    .kind-semantic { color: var(--kind-semantic); }
    .muted { color: var(--muted); }
    .empty { color: var(--muted); padding: 2rem; text-align: center; }
    .case.hidden, .cases-table tr.hidden { display: none; }
  `;
}

function renderScript(): string {
  return `
    (function() {
      var filter = document.getElementById("filter");
      if (filter) {
        filter.addEventListener("input", function(e) {
          var q = e.target.value.toLowerCase().trim();
          document.querySelectorAll(".case[data-case]").forEach(function(el) {
            var name = el.getAttribute("data-case").toLowerCase();
            el.classList.toggle("hidden", q !== "" && name.indexOf(q) === -1);
          });
          document.querySelectorAll(".cases-table tbody tr[data-case]").forEach(function(el) {
            var name = el.getAttribute("data-case").toLowerCase();
            el.classList.toggle("hidden", q !== "" && name.indexOf(q) === -1);
          });
        });
      }
      document.querySelectorAll('[data-action="expand-all"]').forEach(function(btn) {
        btn.addEventListener("click", function() {
          document.querySelectorAll("details").forEach(function(d) { d.open = true; });
        });
      });
      document.querySelectorAll('[data-action="collapse-all"]').forEach(function(btn) {
        btn.addEventListener("click", function() {
          document.querySelectorAll("details").forEach(function(d) { d.open = false; });
        });
      });
      var table = document.getElementById("cases-table");
      if (table) {
        table.querySelectorAll('thead th[data-sortable="true"]').forEach(function(th, idx) {
          var asc = true;
          th.addEventListener("click", function() {
            var tbody = table.querySelector("tbody");
            var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
            var type = th.getAttribute("data-sort-type");
            rows.sort(function(a, b) {
              var av = a.children[idx].getAttribute("data-sort-value") || a.children[idx].textContent || "";
              var bv = b.children[idx].getAttribute("data-sort-value") || b.children[idx].textContent || "";
              if (type === "number") {
                return (parseFloat(av) - parseFloat(bv)) * (asc ? 1 : -1);
              }
              return av.localeCompare(bv) * (asc ? 1 : -1);
            });
            asc = !asc;
            rows.forEach(function(r) { tbody.appendChild(r); });
          });
        });
      }
    })();
  `;
}
