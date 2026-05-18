import chalk from "chalk";
import type {
  BacktestFill,
  BacktestTickEvent,
} from "../shared/backtest/index.js";
import type { GridBotTickEvent } from "../engine/grid-bot.js";

export function formatBacktestFills(fills: BacktestFill[]): string {
  if (fills.length === 0) return "—";
  return fills
    .map((f) => {
      const side = f.side === "buy" ? "BUY" : "SELL";
      const tag = f.trigger === "grid" ? "" : ` (${f.trigger})`;
      return `${side}${tag} ${f.quantity}@${f.price}`;
    })
    .join("; ");
}

export function emitBacktestTracePlain(
  ev: BacktestTickEvent,
  currencySymbol: string,
  out: NodeJS.WritableStream = process.stdout,
): void {
  const idx = String(ev.index).padStart(6, "0");
  const fillsTxt = formatBacktestFills(ev.fills);
  out.write(
    `[t=${idx}] price=${currencySymbol}${ev.close.toFixed(2)} pos=${ev.position.toFixed(5)} ` +
      `cash=${currencySymbol}${ev.cash.toFixed(2)} realized=${ev.realizedPnl.toFixed(2)} ` +
      `unrealized=${signedFixed(ev.unrealizedPnl)} total=${currencySymbol}${ev.totalValue.toFixed(2)} | ${fillsTxt}\n`,
  );
}

export function emitBacktestTraceJson(
  ev: BacktestTickEvent,
  out: NodeJS.WritableStream = process.stdout,
): void {
  out.write(
    JSON.stringify({
      t: ev.index,
      timestamp: ev.timestamp,
      open: ev.open.toString(),
      high: ev.high.toString(),
      low: ev.low.toString(),
      close: ev.close.toString(),
      fills: ev.fills.map((f) => ({
        side: f.side,
        price: f.price.toString(),
        quantity: f.quantity.toString(),
        quoteValue: f.quoteValue.toString(),
        profit: f.profit?.toString(),
        trigger: f.trigger,
      })),
      position: ev.position.toString(),
      cash: ev.cash.toString(),
      realizedPnl: ev.realizedPnl.toString(),
      unrealizedPnl: ev.unrealizedPnl.toString(),
      totalValue: ev.totalValue.toString(),
    }) + "\n",
  );
}

export function emitGridBotTracePlain(
  ev: GridBotTickEvent,
  currencySymbol: string,
  out: NodeJS.WritableStream = process.stdout,
): void {
  const fills = ev.fills.length === 0 ? "—" : ev.fills.join("; ");
  out.write(
    chalk.dim(
      `[t=${String(ev.index).padStart(6, "0")}] price=${currencySymbol}${ev.price.toFixed(2)} ` +
        `pos=${ev.position.toFixed(5)} orders=${ev.openOrders} ` +
        `realized=${ev.realizedPnl.toFixed(2)} unrealized=${signedFixed(ev.unrealizedPnl)} | ${fills}`,
    ) + "\n",
  );
}

export function emitGridBotTraceJson(
  ev: GridBotTickEvent,
  out: NodeJS.WritableStream = process.stdout,
): void {
  out.write(
    JSON.stringify({
      t: ev.index,
      timestamp: ev.timestamp,
      price: ev.price.toString(),
      fills: ev.fills,
      position: ev.position.toString(),
      realizedPnl: ev.realizedPnl.toString(),
      unrealizedPnl: ev.unrealizedPnl.toString(),
      openOrders: ev.openOrders,
    }) + "\n",
  );
}

function signedFixed(v: {
  gte: (n: number) => boolean;
  toFixed: (d: number) => string;
}): string {
  return `${v.gte(0) ? "+" : ""}${v.toFixed(2)}`;
}
