import { Decimal } from "decimal.js";
import chalk from "chalk";
import type { GridState } from "../db/grid-store.js";

export const CURRENCY_SYMBOLS: Record<string, string> = {
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
  uptime: number;
  tickCount: number;
  lastError: string | null;
  warnings: string[];
  telegramConnections: number;
  intervalSec: number;
  lastNotifyOk: number;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;

function visibleLength(str: string): number {
  return str.replace(ANSI_RE, "").length;
}

function truncateVisible(str: string, maxVisible: number): string {
  let vis = 0;
  let i = 0;
  while (i < str.length && vis < maxVisible) {
    if (str[i] === "\x1B") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    vis++;
    i++;
  }
  return str.slice(0, i) + "\x1B[0m";
}

export function getCurrSymbol(pair: string): string {
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

function fmtDelta(current: Decimal, reference: Decimal): string {
  if (reference.isZero()) return "";
  const pct = current.minus(reference).div(reference).times(100);
  const sign = pct.isNegative() || pct.isZero() ? "" : "+";
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
  const maxContent = width - 2;
  let vis = visibleLength(content);
  if (vis > maxContent) {
    content = truncateVisible(content, maxContent - 1) + "\u2026";
    vis = maxContent;
  }
  const pad = Math.max(0, width - vis - 2);
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

function getBoxWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(50, Math.min(80, cols - 2));
}

export function renderDashboard(data: DashboardData): string {
  const { state, currentPrice, uptime } = data;
  const cs = getCurrSymbol(state.pair);
  const W = getBoxWidth();
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
  const gridPrice = new Decimal(state.gridPrice);
  const deltaStr = fmtDelta(currentPrice, gridPrice);
  const deltaLabel = deltaStr ? `${deltaStr} ${chalk.dim("vs entry")}` : "";
  const pairLabel = chalk.bold.cyan(state.pair);
  const priceBlock = deltaLabel ? `${priceStr}  ${deltaLabel}` : priceStr;
  const pairVis = state.pair.length;
  const priceVis = visibleLength(priceBlock);
  const gap = Math.max(3, innerW - 4 - pairVis - priceVis);
  lines.push(padLine(`  ${pairLabel}${" ".repeat(gap)}${priceBlock}`, innerW));
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
  if (state.config.stopLoss && state.config.stopLoss > 0) {
    const slPrice = new Decimal(state.levels[0].price).times(
      1 - state.config.stopLoss / 100,
    );
    lines.push(
      padLine(
        `  ${chalk.dim("Stop-Loss".padEnd(14))}${chalk.red(fmtPrice(slPrice, cs))}  ${chalk.dim(`(−${state.config.stopLoss}%)`)}`,
        innerW,
      ),
    );
  }
  lines.push(
    padLine(
      `  ${chalk.dim("Levels".padEnd(14))}${state.config.levels / 2} per side`,
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
      `  ${chalk.dim("Per Level".padEnd(14))}${fmtPrice(new Decimal(state.quotePerLevel), cs)}`,
      innerW,
    ),
  );
  if (state.levels.length >= 2) {
    const p0 = new Decimal(state.levels[0].price);
    const p1 = new Decimal(state.levels[1].price);
    const ratio = p1.div(p0);
    const profitPct = ratio.minus(1).times(100);
    const profitDollar = new Decimal(state.quotePerLevel).times(ratio.minus(1));
    lines.push(
      padLine(
        `  ${chalk.dim("Profit/Grid".padEnd(14))}${fmtPrice(profitDollar, cs)} (${profitPct.toFixed(2)}%)`,
        innerW,
      ),
    );
  }
  if (state.config.trailingUp) {
    lines.push(
      padLine(
        `  ${chalk.dim("Shifts".padEnd(14))}${state.shiftCount ?? 0}↑`,
        innerW,
      ),
    );
  }
  lines.push(
    padLine(`  ${chalk.dim("Uptime".padEnd(14))}${fmtUptime(uptime)}`, innerW),
  );
  let telegramStr: string;
  if (data.telegramConnections === 0) {
    telegramStr = chalk.yellow("None");
  } else {
    const connLabel = `${data.telegramConnections} connection${data.telegramConnections !== 1 ? "s" : ""}`;
    const staleSec = 5 * 60;
    if (
      data.lastNotifyOk > 0 &&
      Date.now() - data.lastNotifyOk > staleSec * 1000
    ) {
      const ago = Math.floor((Date.now() - data.lastNotifyOk) / 60_000);
      telegramStr = `${connLabel}  ${chalk.yellow(`\u26A0 last OK ${ago}m ago`)}`;
    } else if (data.lastNotifyOk === 0 && data.tickCount > 2) {
      telegramStr = `${connLabel}  ${chalk.yellow("\u26A0 no delivery yet")}`;
    } else {
      telegramStr = connLabel;
    }
  }
  lines.push(
    padLine(`  ${chalk.dim("Telegram".padEnd(14))}${telegramStr}`, innerW),
  );

  if (data.lastError || data.warnings.length > 0) {
    lines.push(padLine("", innerW));
    if (data.lastError) {
      lines.push(
        padLine(
          `  ${chalk.red("\u2717")} ${chalk.yellow(data.lastError)}`,
          innerW,
        ),
      );
    }
    for (const w of data.warnings.slice(0, 3)) {
      lines.push(
        padLine(`  ${chalk.yellow("\u26A0")} ${chalk.yellow(w)}`, innerW),
      );
    }
    if (data.warnings.length > 3) {
      lines.push(
        padLine(
          `  ${chalk.dim(`  ...and ${data.warnings.length - 3} more`)}`,
          innerW,
        ),
      );
    }
  }

  let activeBuys = 0;
  let activeSells = 0;
  let posLevels = 0;
  let heldLevels = 0;
  let idleLevels = 0;
  for (const lv of state.levels) {
    const hasSell = !!lv.sellOrderId;
    const hasBuy = !!lv.buyOrderId;
    const hasPos = lv.hasPosition;
    const sellAbove =
      lv.index + 1 < state.levels.length &&
      !!state.levels[lv.index + 1]?.sellOrderId;
    const isHeld = hasPos && !sellAbove;

    if (hasSell) activeSells++;
    else if (hasBuy) activeBuys++;
    else if (isHeld) heldLevels++;
    else if (hasPos && sellAbove) posLevels++;
    else idleLevels++;
  }

  lines.push(padLine("", innerW));
  lines.push(sectionHeader("GRID STATUS", innerW));
  lines.push(padLine("", innerW));

  const summaryParts: string[] = [
    chalk.green(`${activeBuys} buys`),
    chalk.red(`${activeSells} sells`),
  ];
  if (posLevels > 0) summaryParts.push(chalk.dim(`${posLevels} pos`));
  if (heldLevels > 0) summaryParts.push(chalk.yellow(`${heldLevels} held`));
  if (idleLevels > 0) summaryParts.push(chalk.dim(`${idleLevels} idle`));
  lines.push(
    padLine(
      `  ${chalk.dim("Orders".padEnd(14))}${summaryParts.join("  ")}`,
      innerW,
    ),
  );
  lines.push(padLine("", innerW));

  const sortedLevels = [...state.levels].sort((a, b) => {
    const pa = parseFloat(a.price);
    const pb = parseFloat(b.price);
    return pb - pa;
  });

  let priceMarkerInserted = false;
  for (let si = 0; si < sortedLevels.length; si++) {
    const level = sortedLevels[si];
    const levelPrice = new Decimal(level.price);

    if (!priceMarkerInserted && currentPrice.gte(levelPrice)) {
      const priceLabel = `${fmtPrice(currentPrice, cs)} \u25C4`;
      const dashCount = Math.max(
        2,
        Math.floor((innerW - priceLabel.length - 12) / 2),
      );
      const dashes = chalk.yellow("\u2500".repeat(dashCount));
      lines.push(
        padLine(
          `      ${dashes} ${chalk.yellow.bold(priceLabel)} ${dashes}`,
          innerW,
        ),
      );
      priceMarkerInserted = true;
    }

    const idx = String(level.index + 1).padStart(2);
    const pStr = fmtPrice(levelPrice, cs).padEnd(12);

    let statusStr: string;
    let barStr: string;

    // In the v2 model: sellOrderId on a level means a sell order at this level's price
    // hasPosition means this level bought and holds base (sell is on the level above)
    const hasSell = !!level.sellOrderId;
    const hasBuy = !!level.buyOrderId;
    const hasPos = level.hasPosition;
    const sellAbove =
      level.index + 1 < state.levels.length &&
      !!state.levels[level.index + 1]?.sellOrderId;
    const isHeld = hasPos && !sellAbove;

    if (hasSell) {
      const buyBelow = state.levels[level.index - 1];
      const baseAmt = buyBelow?.hasPosition ? buyBelow.baseHeld : "";
      barStr = chalk.red("\u2592\u2592\u2592\u2592\u2592");
      statusStr = baseAmt
        ? `${chalk.red("SELL")}  ${chalk.dim(baseAmt)}`
        : chalk.red("SELL");
    } else if (hasBuy) {
      barStr = chalk.green("\u2592\u2592\u2592\u2592\u2592");
      statusStr = chalk.green("BUY");
    } else if (isHeld) {
      barStr = chalk.yellow("\u2588\u2588\u2588\u2588\u2588");
      statusStr = `${chalk.yellow("HELD")}  ${chalk.dim(level.baseHeld)}`;
    } else if (hasPos && sellAbove) {
      barStr = chalk.green("\u2588\u2588\u2588\u2588\u2588");
      statusStr = `${chalk.dim("POS")}   ${chalk.dim(level.baseHeld)}`;
    } else {
      barStr = chalk.dim("\u00B7\u00B7\u00B7\u00B7\u00B7");
      statusStr = chalk.dim("\u2014");
    }

    lines.push(
      padLine(
        `  ${chalk.dim(`#${idx}`)}  ${pStr}  ${barStr}  ${statusStr}`,
        innerW,
      ),
    );
  }

  if (!priceMarkerInserted) {
    const priceLabel = `${fmtPrice(currentPrice, cs)} \u25C4`;
    const dashCount = Math.max(
      2,
      Math.floor((innerW - priceLabel.length - 12) / 2),
    );
    const dashes = chalk.yellow("\u2500".repeat(dashCount));
    lines.push(
      padLine(
        `      ${dashes} ${chalk.yellow.bold(priceLabel)} ${dashes}`,
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
      const cost =
        lv.fillCost && lv.fillCost !== "0"
          ? new Decimal(lv.fillCost)
          : held.times(new Decimal(lv.price));
      costBasis = costBasis.plus(cost);
    }
  }
  const unrealized = totalBaseHeld.times(currentPrice).minus(costBasis);

  const realizedPnl = new Decimal(state.stats.realizedPnl);
  const totalPnl = realizedPnl.plus(unrealized);
  const investment = new Decimal(state.config.investment);
  const roiPct = investment.isZero()
    ? new Decimal(0)
    : totalPnl.div(investment).times(100);
  const netValue = investment.plus(totalPnl);

  lines.push(
    padLine(
      `  ${chalk.dim("Realized P&L".padEnd(16))}${fmtPnl(state.stats.realizedPnl, cs)}`,
      innerW,
    ),
  );
  const totalFees = new Decimal(state.stats.totalFees ?? "0");
  lines.push(
    padLine(
      `  ${chalk.dim("Fees Paid".padEnd(16))}${chalk.dim(`${cs}${totalFees.toFixed(2)}`)}`,
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
      `  ${chalk.dim("Total P&L".padEnd(16))}${fmtPnl(totalPnl.toFixed(2), cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("ROI".padEnd(16))}${fmtPnl(roiPct.toFixed(2), "")}%`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Net Value".padEnd(16))}${fmtPrice(netValue, cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Total Trades".padEnd(16))}${state.stats.totalBuys + state.stats.totalSells} (${state.stats.totalBuys} buys, ${state.stats.totalSells} sells)`,
      innerW,
    ),
  );

  const base = state.pair.split("-")[0] ?? "";
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
  lines.push(sectionHeader("", innerW));

  const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const tickLabel = `Tick #${data.tickCount}`;
  const intervalLabel = `Interval: ${data.intervalSec}s`;
  const footerContent = `  ${chalk.dim(now)}  ${chalk.dim("\u2502")}  ${chalk.dim(tickLabel)}  ${chalk.dim("\u2502")}  ${chalk.dim(intervalLabel)}`;
  lines.push(padLine(footerContent, innerW));

  lines.push(padLine("", innerW));
  lines.push(bottomBorder);
  lines.push(chalk.dim("  Press Ctrl+C to stop"));

  return lines.join("\n");
}

export function renderShutdownSummary(
  state: GridState,
  currentPrice: Decimal,
  remainingOrders = 0,
): string {
  const cs = getCurrSymbol(state.pair);
  const lines: string[] = [];

  let totalBaseHeld = new Decimal(0);
  let costBasis = new Decimal(0);
  for (const lv of state.levels) {
    if (lv.hasPosition) {
      const held = new Decimal(lv.baseHeld);
      totalBaseHeld = totalBaseHeld.plus(held);
      const cost =
        lv.fillCost && lv.fillCost !== "0"
          ? new Decimal(lv.fillCost)
          : held.times(new Decimal(lv.price));
      costBasis = costBasis.plus(cost);
    }
  }

  const base = state.pair.split("-")[0] ?? "";
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
    `  ${chalk.dim("Fees Paid".padEnd(18))}${chalk.dim(`${cs}${new Decimal(state.stats.totalFees ?? "0").toFixed(2)}`)}`,
  );
  lines.push(
    `  ${chalk.dim(`${base} Held`.padEnd(18))}${totalBaseHeld.toFixed(8)}`,
  );
  lines.push(
    `  ${chalk.dim(`${base} Value`.padEnd(18))}${fmtPrice(baseValue, cs)}`,
  );
  lines.push(`  ${chalk.dim("Net Value".padEnd(18))}${fmtPrice(netValue, cs)}`);
  lines.push(chalk.dim("  " + "\u2500".repeat(40)));
  if (remainingOrders > 0) {
    lines.push(
      `  ${chalk.yellow(`\u26A0 ${remainingOrders} order${remainingOrders !== 1 ? "s" : ""} could not be cancelled. State saved for next startup.`)}`,
    );
  } else {
    lines.push(`  ${chalk.dim("All orders cancelled. Clean exit.")}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function renderReconciliationSummary(
  buysFilled: number,
  sellsFilled: number,
  ordersKept: number,
  ordersDead: number,
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
  if (ordersKept > 0)
    lines.push(
      `  ${chalk.cyan("\u21BB")} ${ordersKept} order${ordersKept !== 1 ? "s" : ""} kept from previous session`,
    );
  if (ordersDead > 0)
    lines.push(
      `  ${chalk.yellow("\u2717")} ${ordersDead} order${ordersDead !== 1 ? "s" : ""} expired/cancelled on exchange`,
    );
  if (buysFilled + sellsFilled + ordersKept + ordersDead === 0)
    lines.push(`  ${chalk.dim("No leftover orders from previous session")}`);
  lines.push(chalk.dim("  " + "\u2500".repeat(40)));
  lines.push("");
  return lines.join("\n");
}
