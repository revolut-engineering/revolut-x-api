import Table from "cli-table3";
import chalk from "chalk";

export interface ColumnDef<T> {
  header: string;
  key?: keyof T;
  accessor?: (row: T) => string;
  align?: "left" | "right" | "center";
}

export function isJsonOutput(opts: {
  json?: boolean;
  output?: string;
}): boolean {
  return opts.json === true || opts.output === "json";
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printTable<T>(rows: T[], columns: ColumnDef<T>[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim("No data found."));
    return;
  }

  const table = new Table({
    head: columns.map((c) => chalk.bold(c.header)),
    style: { head: [], border: [] },
    colAligns: columns.map((c) => c.align ?? "left"),
  });

  for (const row of rows) {
    table.push(
      columns.map((col) => {
        if (col.accessor) return col.accessor(row);
        if (col.key) {
          const val = row[col.key];
          return val == null ? "" : String(val);
        }
        return "";
      }),
    );
  }

  console.log(table.toString());
}

export function printKeyValue(entries: [string, string][]): void {
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  for (const [key, value] of entries) {
    console.log(`${chalk.bold(key.padEnd(maxKeyLen))}  ${value}`);
  }
}

export function printSuccess(message: string): void {
  console.log(chalk.green(message));
}

export function printWarning(message: string): void {
  console.log(chalk.yellow(message));
}
