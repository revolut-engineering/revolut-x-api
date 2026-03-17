import { createRequire } from "node:module";
import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerAccountCommand } from "./commands/account.js";
import { registerMarketCommand } from "./commands/market.js";
import { registerOrderCommand } from "./commands/order.js";
import { registerTradeCommand } from "./commands/trade.js";
import { registerMonitorCommand } from "./commands/monitor.js";
import { registerEventsCommand } from "./commands/events.js";
import { registerStrategyCommand } from "./commands/strategy.js";
import { registerConnectorCommand } from "./commands/connector.js";

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
  Setup:
    $ revx configure                                      Set up API key and private key

  Account:
    $ revx account balances                               Show non-zero balances
    $ revx account balances --all                         Include zero balances
    $ revx account balance BTC                            Get BTC balance

  Market:
    $ revx market currencies                              List supported currencies
    $ revx market pairs                                   List trading pairs
    $ revx market tickers                                 List all tickers
    $ revx market tickers --symbols BTC-USD,ETH-USD       Filter tickers by pair
    $ revx market ticker BTC-USD                          Get BTC-USD ticker
    $ revx market candles BTC-USD                         Get hourly candles
    $ revx market candles BTC-USD --interval 5m           Get 5-minute candles
    $ revx market candles BTC-USD --since 7d --until today
    $ revx market orderbook BTC-USD                       Get order book (top 10)
    $ revx market orderbook BTC-USD --limit 20            Get order book (top 20)

  Orders:
    $ revx order place BTC-USD buy 0.001 --market         Place market buy
    $ revx order place BTC-USD sell 0.001 --limit 95000   Place limit sell
    $ revx order place BTC-USD buy 0.001 --limit 95000 --post-only
    $ revx order list                                     List active orders
    $ revx order list --symbols BTC-USD --side buy        Filter active orders
    $ revx order history --symbols BTC-USD                Order history for pair
    $ revx order get <order-id>                           Get order details
    $ revx order fills <order-id>                         Get order fills
    $ revx order cancel <order-id>                        Cancel an order
    $ revx order cancel-all                               Cancel all open orders

  Trades:
    $ revx trade history BTC-USD                          Private trade history
    $ revx trade history BTC-USD --limit 100 --start-date 7d
    $ revx trade all BTC-USD                              All public trades
    $ revx trade all BTC-USD --since 7d --limit 200

  Monitor (runs in foreground, Ctrl-C to stop):
    $ revx monitor price BTC-USD --direction above --threshold 100000
    $ revx monitor rsi ETH-USD --direction above --threshold 70 --period 14
    $ revx monitor ema-cross BTC-USD --direction bullish
    $ revx monitor macd BTC-USD --direction bullish --fast 12 --slow 26 --signal 9
    $ revx monitor bollinger BTC-USD --band upper
    $ revx monitor volume-spike BTC-USD --multiplier 3.0
    $ revx monitor spread BTC-USD --direction above --threshold 0.5
    $ revx monitor obi BTC-USD --direction above --threshold 0.3
    $ revx monitor price-change BTC-USD --direction rise --threshold 5.0 --lookback 24
    $ revx monitor atr-breakout BTC-USD --period 14 --multiplier 1.5
    $ revx monitor types                                  List all monitor types

  Strategy:
    $ revx strategy grid backtest BTC-USD --levels 10 --range 10 --investment 1000
    $ revx strategy grid optimize BTC-USD --investment 1000 --days 30 --interval 1h
    $ revx strategy grid run BTC-USD --investment 500 --levels 10 --range 5
    $ revx strategy grid run BTC-USD --investment 500 --dry-run

  Connector (Telegram notifications):
    $ revx connector telegram add --token <token> --chat-id <id>
    $ revx connector telegram add --token <token> --chat-id <id> --test
    $ revx connector telegram list
    $ revx connector telegram test <id>
    $ revx connector telegram delete <id>

  Events:
    $ revx events                                         Show recent alert events
    $ revx events --limit 10                              Show last 10 events
    $ revx events --category alert_triggered              Filter by category`,
    );

  registerConfigureCommand(program);
  registerAccountCommand(program);
  registerMarketCommand(program);
  registerOrderCommand(program);
  registerTradeCommand(program);
  registerMonitorCommand(program);
  registerEventsCommand(program);
  registerStrategyCommand(program);
  registerConnectorCommand(program);

  return program;
}
