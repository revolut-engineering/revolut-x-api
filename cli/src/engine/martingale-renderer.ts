import { Decimal } from "decimal.js";
import chalk from "chalk";
import type { MartingaleState } from "../db/martingale-store.js";

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  USDT: "$",
  USDC: "$",
  EUR: "€",
  GBP: "£",
};

const BOX = {
  tl: "╔",
  tr: "╗",
  bl: "╚",
  br: "╝",
  h: "═",
  v: "║",
  ml: "╠",
  mr: "╣",
};

export interface MartingaleDashboardData {
  state: MartingaleState;
  currentPrice: Decimal;
  uptime: number;
  tickCount: number;
  lastError: string | null;
  warnings: string[];
  telegramConnections: number;
  intervalSec: number;
  lastNotifyOk: number;
  lifecycle: "running" | "finished" | "stopped";
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

export function fmtPrice(price: Decimal | string, cs: string): string {
  let d: Decimal;
  try {
    d = price instanceof Decimal ? price : new Decimal(price);
  } catch {
    return `${cs}0.00`;
  }
  if (!d.isFinite()) return `${cs}0.00`;
  const abs = d.abs();
  const maxFractionDigits = abs.gte(1) ? 2 : 8;
  const num = abs
    .toDecimalPlaces(maxFractionDigits, Decimal.ROUND_HALF_UP)
    .toNumber();
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFractionDigits,
  });
  return `${d.isNegative() ? "-" : ""}${cs}${formatted}`;
}

export function fmtMoney(value: Decimal, cs: string): string {
  return `${value.lt(0) ? "-" : ""}${cs}${value.abs().toFixed(2)}`;
}

export function fmtSignedPnl(value: Decimal, cs: string): string {
  const abs = value.abs().toFixed(2);
  const sign = abs === "0.00" ? "" : value.lt(0) ? "-" : "+";
  return `${sign}${cs}${abs}`;
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
  if (pct.gt(0)) return chalk.green(`▲ ${str}`);
  if (pct.lt(0)) return chalk.red(`▼ ${str}`);
  return chalk.dim(`= ${str}`);
}

export function fmtUptime(ms: number): string {
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
    content = truncateVisible(content, maxContent - 1) + "…";
    vis = maxContent;
  }
  const pad = Math.max(0, width - vis - 2);
  return `${BOX.v} ${content}${" ".repeat(pad)} ${BOX.v}`;
}

function sectionHeader(label: string, width: number): string {
  // width is the inner box width; total line = ╠ + width×═ + ╣ = width + 2 chars,
  // matching topBorder (╔ + width×═ + ╗) and padLine (║ + space + content + space + ║).
  const inner = width;
  const text = label ? ` ${label} ` : "";
  const remaining = Math.max(0, inner - text.length);
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${BOX.ml}${BOX.h.repeat(left)}${text}${BOX.h.repeat(right)}${BOX.mr}`;
}

function getBoxWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(50, Math.min(80, cols - 2));
}

export function renderMartingaleDashboard(
  data: MartingaleDashboardData,
): string {
  const {
    state,
    currentPrice,
    uptime,
    tickCount,
    lastError,
    warnings,
    intervalSec,
  } = data;
  const cs = getCurrSymbol(state.pair);
  const cfg = state.config;
  const W = getBoxWidth();
  const innerW = W;

  const lines: string[] = [];

  const topBorder = `${BOX.tl}${BOX.h.repeat(innerW)}${BOX.tr}`;
  const bottomBorder = `${BOX.bl}${BOX.h.repeat(innerW)}${BOX.br}`;

  lines.push(topBorder);

  const modeTag = cfg.dryRun
    ? `${chalk.yellow("DRY RUN")}`
    : `${chalk.green("●")}  ${chalk.green("LIVE")}`;
  lines.push(
    padLine(
      `${chalk.bold.white("REVX STRATEGY")}  ${chalk.dim("●")}  ${chalk.bold.cyan("MARTINGALE BOT")}  ${chalk.dim("●")}  ${modeTag}`,
      innerW,
    ),
  );

  lines.push(sectionHeader("", innerW));
  lines.push(padLine("", innerW));

  // Pair + price row
  const priceStr = chalk.white.bold(fmtPrice(currentPrice, cs));
  const entryRef =
    state.inPosition && state.avgEntryPrice !== "0"
      ? new Decimal(state.avgEntryPrice)
      : null;
  const deltaStr = entryRef ? fmtDelta(currentPrice, entryRef) : "";
  const deltaLabel = deltaStr ? `${deltaStr} ${chalk.dim("vs entry")}` : "";
  const pairLabel = chalk.bold.cyan(state.pair);
  const priceBlock = deltaLabel ? `${priceStr}  ${deltaLabel}` : priceStr;
  const pairVis = state.pair.length;
  const priceVis = visibleLength(priceBlock);
  const gap = Math.max(3, innerW - 4 - pairVis - priceVis);
  lines.push(padLine(`  ${pairLabel}${" ".repeat(gap)}${priceBlock}`, innerW));
  lines.push(padLine("", innerW));

  // Config key-value list
  lines.push(
    padLine(
      `  ${chalk.dim("Price Deviation".padEnd(16))}${new Decimal(cfg.priceDeviation).times(100).toFixed(2)}%`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Safety Orders".padEnd(16))}${cfg.maxSafetyOrders}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Scale".padEnd(16))}${cfg.safetyOrderVolumeScale}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Take Profit".padEnd(16))}${new Decimal(cfg.takeProfit).times(100).toFixed(2)}%`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Stop-Loss".padEnd(16))}${chalk.red(new Decimal(cfg.stopLoss).times(100).toFixed(2) + "%")}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Investment".padEnd(16))}${fmtPrice(new Decimal(cfg.investment), cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(`  ${chalk.dim("Uptime".padEnd(16))}${fmtUptime(uptime)}`, innerW),
  );

  // Telegram
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
      telegramStr = `${connLabel}  ${chalk.yellow(`⚠ last OK ${ago}m ago`)}`;
    } else if (data.lastNotifyOk === 0 && data.tickCount > 2) {
      telegramStr = `${connLabel}  ${chalk.yellow("⚠ no delivery yet")}`;
    } else {
      telegramStr = connLabel;
    }
  }
  lines.push(
    padLine(`  ${chalk.dim("Telegram".padEnd(16))}${telegramStr}`, innerW),
  );

  // Errors / warnings
  if (lastError || warnings.length > 0) {
    lines.push(padLine("", innerW));
    if (lastError) {
      lines.push(
        padLine(`  ${chalk.red("✗")} ${chalk.yellow(lastError)}`, innerW),
      );
    }
    for (const w of warnings.slice(0, 3)) {
      lines.push(padLine(`  ${chalk.yellow("⚠")} ${chalk.yellow(w)}`, innerW));
    }
    if (warnings.length > 3) {
      lines.push(
        padLine(
          `  ${chalk.dim(`  ...and ${warnings.length - 3} more`)}`,
          innerW,
        ),
      );
    }
  }

  // ── MARTINGALE STATUS ──
  lines.push(padLine("", innerW));
  lines.push(sectionHeader("MARTINGALE STATUS", innerW));
  lines.push(padLine("", innerW));

  const soFilled = state.safetyOrdersFilled;
  const soMax = cfg.maxSafetyOrders;
  const soBar = Array.from({ length: soMax + 1 }, (_, i) =>
    i < soFilled + (state.inPosition ? 1 : 0)
      ? chalk.green("███")
      : chalk.dim("···"),
  ).join(" ");

  if (state.inPosition) {
    const base = state.pair.split("-")[0] ?? "";
    const qty = new Decimal(state.totalQty);
    lines.push(
      padLine(
        `  ${chalk.dim("Position".padEnd(16))}${qty.toFixed(8)} ${base}  ${chalk.dim("avg")} ${fmtPrice(new Decimal(state.avgEntryPrice), cs)}`,
        innerW,
      ),
    );
  } else {
    lines.push(
      padLine(
        `  ${chalk.dim("Position".padEnd(16))}${chalk.dim("Waiting for entry")}`,
        innerW,
      ),
    );
  }
  lines.push(
    padLine(
      `  ${chalk.dim("Safety Orders".padEnd(16))}[${soBar}]  ${soFilled}/${soMax} filled`,
      innerW,
    ),
  );

  let openBuyOrders = 0;
  for (const lv of state.levels) openBuyOrders += lv.buyOrderIds.length;
  const tpOrderCount = state.tpOrderId ? 1 : 0;
  lines.push(
    padLine(
      `  ${chalk.dim("Open Orders".padEnd(16))}${chalk.green(`${openBuyOrders} buys`)}  ${chalk.dim("·")}  ${chalk.red(`${tpOrderCount} TP sell`)}`,
      innerW,
    ),
  );
  lines.push(padLine("", innerW));

  // Order ladder — pre-compute column widths for alignment
  const sorted = [...state.levels].sort(
    (a, b) => parseFloat(b.price) - parseFloat(a.price),
  );
  const pColW = sorted.reduce(
    (m, lv) => Math.max(m, fmtPrice(new Decimal(lv.price), cs).length),
    0,
  );
  const qColW = sorted.reduce(
    (m, lv) => Math.max(m, fmtPrice(new Decimal(lv.quoteSize), cs).length),
    0,
  );
  let markerInserted = false;

  for (const level of sorted) {
    const levelPrice = new Decimal(level.price);

    if (!markerInserted && currentPrice.gte(levelPrice)) {
      const priceLabel = `${fmtPrice(currentPrice, cs)} ◄`;
      const dashCount = Math.max(
        2,
        Math.floor((innerW - priceLabel.length - 12) / 2),
      );
      const dashes = chalk.yellow("─".repeat(dashCount));
      lines.push(
        padLine(
          `      ${dashes} ${chalk.yellow.bold(priceLabel)} ${dashes}`,
          innerW,
        ),
      );
      markerInserted = true;
    }

    const idx = String(level.index + 1).padStart(2);
    const pStr = fmtPrice(levelPrice, cs).padEnd(pColW);
    const qStr = fmtPrice(new Decimal(level.quoteSize), cs).padStart(qColW);

    let barStr: string;
    let statusStr: string;
    const hasBuy = level.buyOrderIds.length > 0;
    const isEntry = level.index === 0;

    if (level.filled) {
      barStr = chalk.green("█████");
      statusStr = chalk.green(isEntry ? "ENTRY" : "SAFETY");
    } else if (hasBuy) {
      const cnt =
        level.buyOrderIds.length > 1
          ? chalk.dim(` (${level.buyOrderIds.length})`)
          : "";
      barStr = chalk.green("▒▒▒▒▒");
      statusStr = chalk.green("BUY") + cnt;
    } else {
      barStr = chalk.dim("·····");
      statusStr = chalk.dim("—");
    }

    lines.push(
      padLine(
        `  ${chalk.dim(`#${idx}`)}  ${pStr}  ${chalk.dim(qStr)}  ${barStr}  ${statusStr}`,
        innerW,
      ),
    );
  }

  if (!markerInserted) {
    const priceLabel = `${fmtPrice(currentPrice, cs)} ◄`;
    const dashCount = Math.max(
      2,
      Math.floor((innerW - priceLabel.length - 12) / 2),
    );
    const dashes = chalk.yellow("─".repeat(dashCount));
    lines.push(
      padLine(
        `      ${dashes} ${chalk.yellow.bold(priceLabel)} ${dashes}`,
        innerW,
      ),
    );
  }

  // TP / SL markers below ladder
  const tpPrice =
    state.inPosition && state.avgEntryPrice !== "0"
      ? new Decimal(state.avgEntryPrice).times(
          new Decimal(1).plus(new Decimal(cfg.takeProfit)),
        )
      : null;
  const slPrice = state.stopLossPrice ? new Decimal(state.stopLossPrice) : null;

  lines.push(padLine("", innerW));
  if (tpPrice) {
    lines.push(
      padLine(
        `  ${chalk.dim("TP target".padEnd(16))}${chalk.green(fmtPrice(tpPrice, cs))}${state.tpOrderId ? chalk.dim("  (order placed)") : chalk.yellow("  (no order yet)")}`,
        innerW,
      ),
    );
  }
  if (slPrice) {
    lines.push(
      padLine(
        `  ${chalk.dim("SL trigger".padEnd(16))}${chalk.red(fmtPrice(slPrice, cs))}`,
        innerW,
      ),
    );
  }

  // ── P&L ──
  lines.push(padLine("", innerW));
  lines.push(sectionHeader("P&L", innerW));
  lines.push(padLine("", innerW));

  const position = new Decimal(state.totalQty);
  const costBasis = new Decimal(state.totalCost);
  const realizedPnl = new Decimal(state.stats.realizedPnl ?? "0");
  const unrealized = position.gt(0)
    ? position.times(currentPrice).minus(costBasis)
    : new Decimal(0);
  const totalPnl = realizedPnl.plus(unrealized);
  const investment = new Decimal(cfg.investment);
  const roiPct = investment.isZero()
    ? new Decimal(0)
    : totalPnl.div(investment).times(100);
  const netValue = investment.plus(totalPnl);
  const base = state.pair.split("-")[0] ?? "";

  lines.push(
    padLine(
      `  ${chalk.dim("Realized P&L".padEnd(16))}${fmtPnl(realizedPnl.toFixed(2), cs)}`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim("Fees Paid".padEnd(16))}${chalk.dim(`${cs}${new Decimal(state.stats.totalFees ?? "0").toFixed(2)}`)}`,
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
      `  ${chalk.dim("Cycles".padEnd(16))}${state.stats.completedCycles} (${state.stats.winningCycles} wins)`,
      innerW,
    ),
  );
  lines.push(
    padLine(
      `  ${chalk.dim(`${base} Held`.padEnd(16))}${position.toFixed(8)}`,
      innerW,
    ),
  );

  // ── RECENT TRADES ──
  lines.push(padLine("", innerW));
  lines.push(sectionHeader("RECENT TRADES", innerW));
  lines.push(padLine("", innerW));

  const recentTrades = state.tradeLog.slice(-8);
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

  // ── Footer ──
  lines.push(padLine("", innerW));
  lines.push(sectionHeader("", innerW));

  const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const tickLabel = `Tick #${tickCount}`;
  const intervalLabel = `Interval: ${intervalSec}s`;
  const footerContent = `  ${chalk.dim(now)}  ${chalk.dim("│")}  ${chalk.dim(tickLabel)}  ${chalk.dim("│")}  ${chalk.dim(intervalLabel)}`;
  lines.push(padLine(footerContent, innerW));

  lines.push(padLine("", innerW));
  lines.push(bottomBorder);
  lines.push(chalk.dim("  Press Ctrl+C to stop"));

  return lines.join("\n");
}

export function renderMartingaleShutdownSummary(
  state: MartingaleState,
  currentPrice: Decimal,
  remainingOrders = 0,
): string {
  const cs = getCurrSymbol(state.pair);
  const lines: string[] = [];

  const position = new Decimal(state.totalQty);
  const costBasis = new Decimal(state.totalCost);
  const realizedPnl = new Decimal(state.stats.realizedPnl ?? "0");
  const unrealized = position.gt(0)
    ? position.times(currentPrice).minus(costBasis)
    : new Decimal(0);
  const netValue = new Decimal(state.config.investment)
    .plus(realizedPnl)
    .plus(unrealized);
  const base = state.pair.split("-")[0] ?? "";
  const baseValue = position.times(currentPrice);

  lines.push("");
  lines.push(chalk.bold("  Martingale Bot Summary"));
  lines.push(chalk.dim("  " + "─".repeat(40)));
  lines.push(
    `  ${chalk.dim("Cycles".padEnd(18))}${state.stats.completedCycles} (${state.stats.winningCycles} wins)`,
  );
  lines.push(`  ${chalk.dim("Total Buys".padEnd(18))}${state.stats.totalBuys}`);
  lines.push(
    `  ${chalk.dim("Total Sells".padEnd(18))}${state.stats.totalSells}`,
  );
  lines.push(
    `  ${chalk.dim("Realized P&L".padEnd(18))}${fmtPnl(realizedPnl.toFixed(2), cs)}`,
  );
  lines.push(
    `  ${chalk.dim("Fees Paid".padEnd(18))}${chalk.dim(`${cs}${new Decimal(state.stats.totalFees ?? "0").toFixed(2)}`)}`,
  );
  lines.push(`  ${chalk.dim(`${base} Held`.padEnd(18))}${position.toFixed(8)}`);
  lines.push(
    `  ${chalk.dim(`${base} Value`.padEnd(18))}${fmtPrice(baseValue, cs)}`,
  );
  lines.push(`  ${chalk.dim("Net Value".padEnd(18))}${fmtPrice(netValue, cs)}`);
  lines.push(chalk.dim("  " + "─".repeat(40)));
  if (remainingOrders > 0) {
    lines.push(
      `  ${chalk.yellow(`⚠ ${remainingOrders} order${remainingOrders !== 1 ? "s" : ""} could not be cancelled. State saved for next startup.`)}`,
    );
  } else {
    lines.push(`  ${chalk.dim("All orders cancelled. Clean exit.")}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function renderMartingaleReconciliationSummary(
  buysFilled: number,
  sellsFilled: number,
  ordersKept: number,
  ordersDead: number,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("  Reconciliation Summary"));
  lines.push(chalk.dim("  " + "─".repeat(40)));
  if (buysFilled > 0)
    lines.push(
      `  ${chalk.green("✓")} ${buysFilled} buy order${buysFilled !== 1 ? "s" : ""} filled while offline`,
    );
  if (sellsFilled > 0)
    lines.push(
      `  ${chalk.green("✓")} ${sellsFilled} sell order${sellsFilled !== 1 ? "s" : ""} filled while offline`,
    );
  if (ordersKept > 0)
    lines.push(
      `  ${chalk.cyan("↻")} ${ordersKept} order${ordersKept !== 1 ? "s" : ""} kept from previous session`,
    );
  if (ordersDead > 0)
    lines.push(
      `  ${chalk.yellow("✗")} ${ordersDead} order${ordersDead !== 1 ? "s" : ""} expired/cancelled on exchange`,
    );
  if (buysFilled + sellsFilled + ordersKept + ordersDead === 0)
    lines.push(`  ${chalk.dim("No leftover orders from previous session")}`);
  lines.push(chalk.dim("  " + "─".repeat(40)));
  lines.push("");
  return lines.join("\n");
}
