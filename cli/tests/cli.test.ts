import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { createProgram } from "../src/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

describe("CLI program", () => {
  it("creates program with correct name", () => {
    const program = createProgram();
    expect(program.name()).toBe("revx");
  });

  it("has version", () => {
    const program = createProgram();
    expect(program.version()).toBe(pkg.version);
  });

  it("has all top-level commands", () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("configure");
    expect(names).toContain("account");
    expect(names).toContain("market");
    expect(names).toContain("order");
    expect(names).toContain("trade");
    expect(names).toContain("connector");
    expect(names).toContain("monitor");
    expect(names).toContain("events");
  });

  it("connector has telegram subcommand", () => {
    const program = createProgram();
    const connector = program.commands.find((c) => c.name() === "connector");
    const connectorSubs = connector.commands.map((c) => c.name());
    expect(connectorSubs).toContain("telegram");
  });

  it("connector telegram has subcommands", () => {
    const program = createProgram();
    const connector = program.commands.find((c) => c.name() === "connector");
    const telegram = connector.commands.find((c) => c.name() === "telegram");
    const subNames = telegram.commands.map((c) => c.name());
    expect(subNames).toContain("add");
    expect(subNames).toContain("list");
    expect(subNames).toContain("delete");
    expect(subNames).toContain("enable");
    expect(subNames).toContain("disable");
    expect(subNames).toContain("test");
  });

  it("configure has subcommands", () => {
    const program = createProgram();
    const configure = program.commands.find((c) => c.name() === "configure");
    const subNames = configure.commands.map((c) => c.name());
    expect(subNames).toContain("get");
    expect(subNames).toContain("set");
    expect(subNames).toContain("generate-keypair");
    expect(subNames).toContain("path");
  });

  it("market has subcommands", () => {
    const program = createProgram();
    const market = program.commands.find((c) => c.name() === "market");
    const subNames = market.commands.map((c) => c.name());
    expect(subNames).toContain("currencies");
    expect(subNames).toContain("pairs");
    expect(subNames).toContain("tickers");
    expect(subNames).toContain("ticker");
    expect(subNames).toContain("candles");
    expect(subNames).toContain("orderbook");
  });

  it("order has subcommands", () => {
    const program = createProgram();
    const order = program.commands.find((c) => c.name() === "order");
    const subNames = order.commands.map((c) => c.name());
    expect(subNames).toContain("place");
    expect(subNames).toContain("list");
    expect(subNames).toContain("history");
    expect(subNames).toContain("get");
    expect(subNames).toContain("cancel");
    expect(subNames).toContain("cancel-all");
    expect(subNames).toContain("fills");
  });

  it("trade has subcommands", () => {
    const program = createProgram();
    const trade = program.commands.find((c) => c.name() === "trade");
    const subNames = trade.commands.map((c) => c.name());
    expect(subNames).toContain("history");
  });

  it("monitor has subcommands", () => {
    const program = createProgram();
    const monitor = program.commands.find((c) => c.name() === "monitor");
    const subNames = monitor.commands.map((c) => c.name());
    expect(subNames).toContain("price");
    expect(subNames).toContain("rsi");
    expect(subNames).toContain("ema-cross");
    expect(subNames).toContain("macd");
    expect(subNames).toContain("bollinger");
    expect(subNames).toContain("volume-spike");
    expect(subNames).toContain("spread");
    expect(subNames).toContain("obi");
    expect(subNames).toContain("price-change");
    expect(subNames).toContain("atr-breakout");
    expect(subNames).toContain("types");
  });

  it("account has subcommands", () => {
    const program = createProgram();
    const account = program.commands.find((c) => c.name() === "account");
    const subNames = account.commands.map((c) => c.name());
    expect(subNames).toContain("balances");
    expect(subNames).toContain("balance");
  });
});
