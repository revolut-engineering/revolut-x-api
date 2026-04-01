import { Command } from "commander";
import chalk from "chalk";
import {
  loadConnections,
  createConnection,
  getConnection,
  updateConnection,
  deleteConnection,
  type TelegramConnection,
} from "../db/store.js";
import { handleError } from "../util/errors.js";
import {
  isJsonOutput,
  printJson,
  printTable,
  printKeyValue,
  printSuccess,
  type ColumnDef,
} from "../output/formatter.js";

function printSectionHeader(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  console.log(chalk.dim("─".repeat(50)));
}

function maskToken(token: string): string {
  if (token.length <= 10) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) return { ok: true };
    const body = (await resp.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return {
      ok: false,
      error: String(body.description ?? `HTTP ${resp.status}`),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const CONN_COLUMNS: ColumnDef<TelegramConnection>[] = [
  { header: "ID", key: "id" },
  { header: "Label", key: "label" },
  { header: "Chat ID", key: "chat_id" },
  { header: "Token", accessor: (c) => chalk.gray(maskToken(c.bot_token)) },
  {
    header: "Enabled",
    accessor: (c) => (c.enabled ? chalk.green("yes") : chalk.gray("no")),
  },
  { header: "Created", accessor: (c) => c.created_at.slice(0, 19) },
];

export function registerConnectorCommand(program: Command): void {
  const connector = program
    .command("connector")
    .description("Notification connector management")
    .configureOutput({
      outputError: (str, write) => {
        const cleanedMsg = str.replace(/^error:\s*/i, "").trim();
        write(`${chalk.red.bold("✖ Error:")} ${chalk.white(cleanedMsg)}\n`);
      },
    });

  const telegram = connector
    .command("telegram")
    .description("Telegram connection management")
    .addHelpText(
      "after",
      `
Examples:
  $ revx connector telegram add --token <token> --chat-id <id>  Add connection
  $ revx connector telegram add --token <token> --chat-id <id> --test
  $ revx connector telegram list                                List connections
  $ revx connector telegram test <id>                           Send test message
  $ revx connector telegram delete <id>                         Delete connection`,
    );

  telegram
    .command("add")
    .description("Add a Telegram connection")
    .requiredOption("--token <token>", "Telegram Bot API token")
    .requiredOption("--chat-id <id>", "Telegram chat ID")
    .option("--label <label>", "Connection label", "default")
    .option("--test", "Send a test message after adding")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(
      async (opts: {
        token: string;
        chatId: string;
        label: string;
        test?: boolean;
        json?: boolean;
        output?: string;
      }) => {
        try {
          const conn = createConnection(
            opts.token.trim(),
            opts.chatId.trim(),
            opts.label.trim() || "default",
          );

          let testResult: { ok: boolean; error?: string } | undefined;
          if (opts.test) {
            testResult = await sendTelegramMessage(
              conn.bot_token,
              conn.chat_id,
              "Test message from RevolutX CLI",
            );
          }

          if (isJsonOutput(opts)) {
            printJson({
              ...conn,
              bot_token: maskToken(conn.bot_token),
              test_result: testResult,
            });
          } else {
            printSectionHeader("New Telegram Connection");
            printSuccess("✓ Telegram connection added successfully.\n");

            printKeyValue([
              ["ID", chalk.white.bold(conn.id)],
              ["Label", chalk.cyan(conn.label)],
              ["Chat ID", conn.chat_id],
              ["Token", chalk.gray(maskToken(conn.bot_token))],
            ]);

            if (testResult) {
              console.log(""); // Spacing
              if (testResult.ok) {
                printSuccess("✓ Test message sent successfully.");
              } else {
                console.error(
                  `${chalk.red.bold("✖ Test message failed:")} ${chalk.white(testResult.error)}`,
                );
              }
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  telegram
    .command("list")
    .description("List Telegram connections")
    .option("--json", "Output as JSON")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(async (opts: { json?: boolean; output?: string }) => {
      try {
        const all = loadConnections();
        if (isJsonOutput(opts)) {
          printJson(
            all.map((c) => ({ ...c, bot_token: maskToken(c.bot_token) })),
          );
        } else {
          printSectionHeader("Telegram Connections");
          if (all.length === 0) {
            console.log(chalk.gray("No Telegram connections found."));
            console.log(
              chalk.dim(
                "  ↳ Use 'revx connector telegram add' to create one.\n",
              ),
            );
          } else {
            printTable(all, CONN_COLUMNS);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  telegram
    .command("delete <connection-id>")
    .description("Delete a Telegram connection")
    .action(async (connectionId: string) => {
      try {
        const ok = deleteConnection(connectionId);
        if (!ok) {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white(`Connection ${chalk.cyan(connectionId)} not found.`)}`,
          );
          process.exit(1);
        }
        printSuccess(`✓ Connection ${chalk.cyan(connectionId)} deleted.`);
      } catch (err) {
        handleError(err);
      }
    });

  telegram
    .command("enable <connection-id>")
    .description("Enable a Telegram connection")
    .action(async (connectionId: string) => {
      try {
        const result = updateConnection(connectionId, { enabled: true });
        if (!result) {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white(`Connection ${chalk.cyan(connectionId)} not found.`)}`,
          );
          process.exit(1);
        }
        printSuccess(`✓ Connection ${chalk.cyan(connectionId)} enabled.`);
      } catch (err) {
        handleError(err);
      }
    });

  telegram
    .command("disable <connection-id>")
    .description("Disable a Telegram connection")
    .action(async (connectionId: string) => {
      try {
        const result = updateConnection(connectionId, { enabled: false });
        if (!result) {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white(`Connection ${chalk.cyan(connectionId)} not found.`)}`,
          );
          process.exit(1);
        }
        printSuccess(`✓ Connection ${chalk.cyan(connectionId)} disabled.`);
      } catch (err) {
        handleError(err);
      }
    });

  telegram
    .command("test <connection-id>")
    .description("Send a test message through a connection")
    .option(
      "--message <msg>",
      "Custom test message",
      "Test message from RevolutX CLI",
    )
    .action(async (connectionId: string, opts: { message: string }) => {
      try {
        const conn = getConnection(connectionId);
        if (!conn) {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white(`Connection ${chalk.cyan(connectionId)} not found.`)}`,
          );
          process.exit(1);
        }
        const result = await sendTelegramMessage(
          conn.bot_token,
          conn.chat_id,
          opts.message,
        );
        if (result.ok) {
          printSuccess(
            `✓ Test message sent to connection ${chalk.cyan(connectionId)}.`,
          );
        } else {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white(`Test failed: ${result.error}`)}`,
          );
          process.exit(1);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
