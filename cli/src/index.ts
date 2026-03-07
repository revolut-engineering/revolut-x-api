import { createRequire } from "node:module";
import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerAccountCommand } from "./commands/account.js";
import { registerMarketCommand } from "./commands/market.js";
import { registerOrderCommand } from "./commands/order.js";
import { registerTradeCommand } from "./commands/trade.js";
import { registerTelegramCommand } from "./commands/telegram.js";
import { registerMonitorCommand } from "./commands/monitor.js";
import { registerEventsCommand } from "./commands/events.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function createProgram(): Command {
  const program = new Command();

  program
    .name("revx")
    .description("Revolut X Exchange CLI")
    .version(version)
    .addHelpText(
      "after",
      `
Examples:
  $ revx configure                        Set up API key and private key
  $ revx account balances                 Show account balances
  $ revx market tickers                   List all tickers
  $ revx market candles BTC-USD           Get OHLCV candles for BTC-USD
  $ revx order place BTC-USD buy 0.001 --limit 95000
  $ revx order list                       List active orders
  $ revx trade history BTC-USD            Show private trade history
  $ revx telegram add --token <token> --chat-id <id>
  $ revx monitor price BTC-USD --direction above --threshold 100000
  $ revx monitor rsi ETH-USD --direction above --threshold 70
  $ revx events                           View alert events`,
    );

  registerConfigureCommand(program);
  registerAccountCommand(program);
  registerMarketCommand(program);
  registerOrderCommand(program);
  registerTradeCommand(program);
  registerTelegramCommand(program);
  registerMonitorCommand(program);
  registerEventsCommand(program);

  return program;
}
