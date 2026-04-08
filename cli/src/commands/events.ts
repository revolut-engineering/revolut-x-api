import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { loadEvents } from "../db/store.js";

function printSectionHeader(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  console.log(chalk.dim("─".repeat(50)));
}

export function registerEventsCommand(program: Command): void {
  program
    .command("events")
    .description("View alert trigger and notification events")
    .configureOutput({
      outputError: (str, write) => {
        const cleanedMsg = str.replace(/^error:\s*/i, "").trim();
        write(`${chalk.red.bold("✖ Error:")} ${chalk.white(cleanedMsg)}\n`);
      },
    })
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
    .option("--category <type>", "Filter by category (alert_triggered)")
    .option("--json", "Output as JSON")
    .action((opts: { limit: string; category?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10) || 50;
      const events = loadEvents({ category: opts.category, limit });

      if (opts.json) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }

      const title = opts.category
        ? `Events (Category: ${opts.category})`
        : "Recent Events";

      printSectionHeader(title);

      if (events.length === 0) {
        console.log(chalk.gray("No events found."));
        if (opts.category) {
          console.log(
            chalk.dim(
              `  ↳ Try removing the --category flag or using a different one.\n`,
            ),
          );
        } else {
          console.log("");
        }
        return;
      }

      const table = new Table({
        head: [
          chalk.bold.white("Time"),
          chalk.bold.white("Category"),
          chalk.bold.white("Details"),
        ],
        colWidths: [22, 22, 50],
        wordWrap: true,
        style: {
          head: [],
          border: ["gray", "dim"],
        },
      });

      for (const event of events) {
        const time = chalk.gray(
          new Date(event.ts).toLocaleString("en-GB", {
            hour12: false,
          }),
        );

        const categoryStr =
          event.category === "alert_triggered"
            ? chalk.yellow(event.category)
            : chalk.cyan(event.category);

        const details = Object.entries(event.details)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${chalk.white(k)}: ${chalk.cyan(v)}`)
          .join(", ");

        table.push([time, categoryStr, details]);
      }

      console.log(table.toString());
    });
}
