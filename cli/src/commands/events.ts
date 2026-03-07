import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { loadEvents } from "../db/store.js";

export function registerEventsCommand(program: Command): void {
  program
    .command("events")
    .description("View alert trigger and notification events")
    .addHelpText(
      "after",
      `
Examples:
  $ revx events                                    Show recent events
  $ revx events --limit 10                         Show last 10 events
  $ revx events --category alert_triggered         Filter by category
  $ revx events --json                             Output as JSON`,
    )
    .option("--limit <n>", "Number of events to show", "50")
    .option(
      "--category <type>",
      "Filter by category (alert_triggered, telegram_send_ok, telegram_send_fail)",
    )
    .option("--json", "Output as JSON")
    .action((opts: { limit: string; category?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10) || 50;
      const events = loadEvents({ category: opts.category, limit });

      if (events.length === 0) {
        console.log(chalk.dim("No events found."));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }

      const table = new Table({
        head: ["Time", "Category", "Details"],
        colWidths: [22, 22, 50],
        wordWrap: true,
      });

      for (const event of events) {
        const time = new Date(event.ts).toLocaleString("en-GB", {
          hour12: false,
        });
        const details = Object.entries(event.details)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        table.push([time, event.category, details]);
      }

      console.log(table.toString());
    });
}
