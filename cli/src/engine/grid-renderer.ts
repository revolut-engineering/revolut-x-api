import { Decimal } from "decimal.js";
import chalk from "chalk";
import type { GridState } from "../db/grid-store.js";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  USDT: "$",
  USDC: "$",
  EUR: "\u20AC",
  GBP: "\u00A3",
};

const BOX = {
  tl: "\u2554",
  tr: "\u2557",
  bl: "\u255A",
  br: "\u255D",
  h: "\u2550",
  v: "\u2551",
  ml: "\u2560",
  mr: "\u2563",
};

export interface DashboardData {
  state: GridState;
  currentPrice: Decimal;
  previousPrice: Decimal | null;
  uptime: number;
  tickCount: number;
  lastError: string | null;
  telegramConnections: number;
}

function stripAnsi(str: string): number {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "").length;
}

function getCurrSymbol(pair: string): string {
  const quote = pair.split("-")[1] ?? "";
  return CURRENCY_SYMBOLS[quote] ?? "";
}

function fmtPrice(price: Decimal | string, cs: string): string {
  const num = typeof price === "string" ? parseFloat(price) : price.toNumber();
  if (isNaN(num)) return `${cs}0.00`;
  const formatted =
    num < 1
      ? num.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 8,
        })
      : num.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  return `${cs}${formatted}`;
}

function fmtPnl(value: string, cs: string): string {
  const num = parseFloat(value);
  if (isNaN(num)) return `${cs}0.00`;
  const sign = num >= 0 ? "+" : "";
  const formatted = Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const str = `${sign}${cs}${formatted}`;
  if (num > 0) return chalk.green(str);
  if (num < 0) return chalk.red(`-${cs}${formatted}`);
  return chalk.dim(str);
}

function fmtDelta(current: Decimal, previous: Decimal): string {
  if (previous.isZero()) return "";
  const pct = current.minus(previous).div(previous).times(100);
  const sign = pct.isNegative() ? "" : "+";
  const str = `${sign}${pct.toFixed(2)}%`;
  if (pct.gt(0)) return chalk.green(`\u25B2 ${str}`);
  if (pct.lt(0)) return chalk.red(`\u25BC ${str}`);
  return chalk.dim(`= ${str}`);
}

function fmtUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function padLine(content: string, width: number): string {
  const visible = stripAnsi(content);
  const pad = Math.max(0, width - visible - 2);
  return `${BOX.v} ${content}${" ".repeat(pad)} ${BOX.v}`;
}

function sectionHeader(label: string, width: number): string {
  const inner = width - 2;
  const text = ` ${label} `;
  const remaining = inner - text.length;
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${BOX.ml}${BOX.h.repeat(left)}${text}${BOX.h.repeat(right)}${BOX.mr}`;
}

export function renderDashboard(data: DashboardData): string {
  const { state, currentPrice, previousPrice, uptime } = data;
  const cs = getCurrSymbol(state.pair);
  const W = 60;
  const innerW = W;

  const lines: string[] = [];

  const topBorder = `${BOX.tl}${BOX.h.repeat(innerW)}${BOX.tr}`;
  const bottomBorder = `${BOX.bl}${BOX.h.repeat(innerW)}${BOX.br}`;

  lines.push(topBorder);

  const modeTag = state.config.dryRun
    ? `${chalk.yellow("DRY RUN")}`
    : `${chalk.green("\u25CF")}  ${chalk.green("LIVE")}`;
  lines.push(
    padLine(
      `${chalk.bold.white("REVX STRATEGY")}  ${chalk.dim("\u25CF")}  ${chalk.bold.cyan("GRID BOT")}  ${chalk.dim("\u25CF")}  ${modeTag}`,
      innerW,
    ),
  );

  lines.push(sectionHeader("", innerW));
  lines.push(padLine("", innerW));

  const priceStr = chalk.white.bold(fmtPrice(currentPrice, cs));
  const deltaStr = previousPrice ? fmtDelta(currentPrice, previousPrice) : "";
  lines.push(
    padLine(
      `  ${chalk.bold.cyan(state.pair)}       ${priceStr}    ${deltaStr}`,
      innerW,
    ),
  );
  lines.push(padLine("", innerW));

  const rangeLow = new Decimal(state.gridPrice).times(
    new Decimal(1).minus(state.config.rangePct),
  );
  const rangeHigh = new Decimal(state.gridPrice).times(
    new Decimal(1).plus(state.config.rangePct),
  );
  const rangePctDisplay = new Decimal(state.config.rangePct)
    .times(100)
    .toFixed(1);
  lines.push(
    padLine(
      `  ${chalk.dim("Grid Range".padEnd(14))}${fmtPrice(rangeLow, cs)} \u2014 ${fmtPrice(rangeHigh, cs)}  ${chalk.dim(`(\u00B1${rangePctDisplay}%)`)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Levels".padEnd(14))}${state.config.levels}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Investment".padEnd(14))}${fmtPrice(new Decimal(state.config.investment), cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Per Level".padEnd(14))}${fmtPrice(new Decimal(state.usdPerLevel), cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(`  ${chalk.dim("Uptime".padEnd(14))}${fmtUptime(uptime)}`, innerW),
  );

  const telegramStr =
    data.telegramConnections > 0
      ? `${data.telegramConnections} connection${data.telegramConnections !== 1 ? "s" : ""}`
      : chalk.yellow("None");
  lines.push(
    padLine(`  ${chalk.dim("Telegram".padEnd(14))}${telegramStr}`, innerW),
  );

  if (data.lastError) {
    lines.push(padLine("", innerW));
    lines.push(
      padLine(
        `  ${chalk.red("\u2717")} ${chalk.yellow(data.lastError)}`,
        innerW,
      ),
    );
  }

  lines.push(padLine("", innerW));
  lines.push(sectionHeader("GRID STATUS", innerW));
  lines.push(padLine("", innerW));

  const sortedLevels = [...state.levels].sort((a, b) => {
    const pa = parseFloat(a.price);
    const pb = parseFloat(b.price);
    return pb - pa;
  });

  for (const level of sortedLevels) {
    const levelPrice = new Decimal(level.price);
    const priceDistance = currentPrice.minus(levelPrice).abs();
    const isClosest = sortedLevels.every((other) => {
      const otherDist = currentPrice.minus(new Decimal(other.price)).abs();
      return priceDistance.lte(otherDist);
    });

    const idx = String(level.index + 1).padStart(2);
    const pStr = fmtPrice(levelPrice, cs).padEnd(12);

    let statusStr: string;
    let barStr: string;
    if (level.hasPosition) {
      barStr = chalk.cyan("\u2588\u2588\u2588\u2588\u2588");
      statusStr = `${chalk.cyan("POS")}   ${chalk.white(level.baseHeld)}`;
    } else if (level.sellOrderId) {
      barStr = chalk.red("\u2592\u2592\u2592\u2592\u2592");
      statusStr = chalk.red("SELL");
    } else if (level.buyOrderId) {
      barStr = chalk.green("\u2592\u2592\u2592\u2592\u2592");
      statusStr = chalk.green("BUY");
    } else {
      barStr = chalk.dim("\u00B7\u00B7\u00B7\u00B7\u00B7");
      statusStr = chalk.dim("\u2014");
    }

    const marker = isClosest ? chalk.yellow("\u25C4") : " ";
    lines.push(
      padLine(
        `  ${chalk.dim(`#${idx}`)}  ${pStr}  ${barStr}  ${statusStr}  ${marker}`,
        innerW,
      ),
    );
  }

  lines.push(padLine("", innerW));
  lines.push(sectionHeader("P&L", innerW));
  lines.push(padLine("", innerW));

  let totalBaseHeld = new Decimal(0);
  let costBasis = new Decimal(0);
  for (const lv of state.levels) {
    if (lv.hasPosition) {
      const held = new Decimal(lv.baseHeld);
      totalBaseHeld = totalBaseHeld.plus(held);
      costBasis = costBasis.plus(held.times(new Decimal(lv.price)));
    }
  }
  const unrealized = totalBaseHeld.times(currentPrice).minus(costBasis);

  lines.push(
    padLine(
      `  ${chalk.dim("Realized P&L".padEnd(16))}${fmtPnl(state.stats.realizedPnl, cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Unrealized".padEnd(16))}${fmtPnl(unrealized.toFixed(2), cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Total Trades".padEnd(16))}${state.stats.totalBuys + state.stats.totalSells} (${state.stats.totalBuys} buys, ${state.stats.totalSells} sells)`,
      innerW,
    ),
  );

  const base = state.pair.split("-")[0] ?? "BTC";
  lines.push(
    padLine(
      `  ${chalk.dim(`${base} Held`.padEnd(16))}${totalBaseHeld.toFixed(8)}`,
      innerW,
    ),
  );

  lines.push(padLine("", innerW));
  lines.push(sectionHeader("RECENT TRADES", innerW));
  lines.push(padLine("", innerW));

  const recentTrades = state.tradeLog.slice(-8).reverse();
  if (recentTrades.length === 0) {
    lines.push(padLine(`  ${chalk.dim("No trades yet")}`, innerW));
  } else {
    for (const trade of recentTrades) {
      const time = new Date(trade.ts).toLocaleTimeString("en-GB", {
        hour12: false,
      });
      const sideStr =
        trade.side === "buy" ? chalk.green("BUY ") : chalk.red("SELL");
      const profitStr =
        trade.profit != null ? `  ${fmtPnl(trade.profit, cs)}` : "";
      lines.push(
        padLine(
          `  ${chalk.dim(time)}  ${sideStr}  ${fmtPrice(new Decimal(trade.price), cs)}  ${trade.quantity}${profitStr}`,
          innerW,
        ),
      );
    }
  }

  lines.push(padLine("", innerW));
  lines.push(bottomBorder);
  lines.push(chalk.dim("  Press Ctrl+C to stop"));

  return lines.join("\n");
}

export function renderShutdownSummary(
  state: GridState,
  currentPrice: Decimal,
): string {
  const cs = getCurrSymbol(state.pair);
  const lines: string[] = [];

  let totalBaseHeld = new Decimal(0);
  let costBasis = new Decimal(0);
  for (const lv of state.levels) {
    if (lv.hasPosition) {
      const held = new Decimal(lv.baseHeld);
      totalBaseHeld = totalBaseHeld.plus(held);
      costBasis = costBasis.plus(held.times(new Decimal(lv.price)));
    }
  }

  const base = state.pair.split("-")[0] ?? "BTC";
  const baseValue = totalBaseHeld.times(currentPrice);
  const investment = new Decimal(state.config.investment);
  const realizedPnl = new Decimal(state.stats.realizedPnl);
  const unrealizedPnl = baseValue.minus(costBasis);
  const netValue = investment.plus(realizedPnl).plus(unrealizedPnl);

  lines.push("");
  lines.push(chalk.bold("  Grid Bot Summary"));
  lines.push(chalk.dim("  " + "\u2500".repeat(40)));
  lines.push(`  ${chalk.dim("Total Buys".padEnd(18))}${state.stats.totalBuys}`);
  lines.push(
    `  ${chalk.dim("Total Sells".padEnd(18))}${state.stats.totalSells}`,
  );
  lines.push(
    `  ${chalk.dim("Realized P&L".padEnd(18))}${fmtPnl(state.stats.realizedPnl, cs)}`,
  );
  lines.push(
    `  ${chalk.dim(`${base} Held`.padEnd(18))}${totalBaseHeld.toFixed(8)}`,
  );
  lines.push(
    `  ${chalk.dim(`${base} Value`.padEnd(18))}${fmtPrice(baseValue, cs)}`,
  );
  lines.push(`  ${chalk.dim("Net Value".padEnd(18))}${fmtPrice(netValue, cs)}`);
  lines.push(chalk.dim("  " + "\u2500".repeat(40)));
  lines.push(`  ${chalk.dim("State saved for resume")}`);
  lines.push("");

  return lines.join("\n");
}

export function renderReconciliationSummary(
  buysFilled: number,
  sellsFilled: number,
  buysReplaced: number,
  sellsReplaced: number,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("  Reconciliation Summary"));
  lines.push(chalk.dim("  " + "\u2500".repeat(40)));
  if (buysFilled > 0)
    lines.push(
      `  ${chalk.green("\u2713")} ${buysFilled} buy order${buysFilled !== 1 ? "s" : ""} filled while offline`,
    );
  if (sellsFilled > 0)
    lines.push(
      `  ${chalk.green("\u2713")} ${sellsFilled} sell order${sellsFilled !== 1 ? "s" : ""} filled while offline`,
    );
  if (buysReplaced > 0)
    lines.push(
      `  ${chalk.yellow("\u21BB")} ${buysReplaced} buy order${buysReplaced !== 1 ? "s" : ""} re-placed`,
    );
  if (sellsReplaced > 0)
    lines.push(
      `  ${chalk.yellow("\u21BB")} ${sellsReplaced} sell order${sellsReplaced !== 1 ? "s" : ""} re-placed`,
    );
  if (buysFilled + sellsFilled + buysReplaced + sellsReplaced === 0)
    lines.push(`  ${chalk.dim("No changes detected since last run")}`);
  lines.push(chalk.dim("  " + "\u2500".repeat(40)));
  lines.push("");
  return lines.join("\n");
}
