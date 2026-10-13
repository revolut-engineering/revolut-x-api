import { Command, Option } from "commander";
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
import { maskSecret } from "../util/mask.js";
import { sendMessage } from "../engine/notify.js";
import {
  LOCAL_TIME_NOTE,
  formatLocalDateTime,
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

const BOT_TOKEN_FORMAT = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_FORMAT = /^(-?[1-9]\d{0,15}|@[A-Za-z][A-Za-z0-9_]{4,})$/;
const TEST_MESSAGE = "Test message from Revolut X CLI";

function connectionInputProblem(token: string, chatId: string): string | null {
  if (!BOT_TOKEN_FORMAT.test(token)) {
    return "--token doesn't look like a Telegram bot token. It is digits, a colon, then the secret from @BotFather.";
  }
  if (!CHAT_ID_FORMAT.test(chatId)) {
    return `--chat-id must be a number such as 123456789 or -1001234567890, or a channel name such as @mychannel, got "${chatId}".`;
  }
  return null;
}

const CONN_COLUMNS: ColumnDef<TelegramConnection>[] = [
  { header: "ID", key: "id" },
  { header: "Label", key: "label" },
  { header: "Chat ID", key: "chat_id" },
  { header: "Token", accessor: (c) => chalk.gray(maskSecret(c.bot_token)) },
  {
    header: "Enabled",
    accessor: (c) => (c.enabled ? chalk.green("yes") : chalk.gray("no")),
  },
  { header: "Created", accessor: (c) => formatLocalDateTime(c.created_at) },
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
    })
    .addHelpText(
      "after",
      `
Examples:
  $ revx connector telegram add --token <token> --chat-id <id>  Add a Telegram connection
  $ revx connector telegram list                                List connections`,
    );

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
  $ revx connector telegram test <id> --message "hello"         Send custom message
  $ revx connector telegram enable <id>                         Resume notifications
  $ revx connector telegram disable <id>                        Pause notifications
  $ revx connector telegram delete <id>                         Delete connection

Only enabled connections receive monitor and grid bot notifications.`,
    );

  telegram
    .command("add")
    .description("Add a Telegram connection")
    .requiredOption("--token <token>", "Telegram Bot API token")
    .requiredOption("--chat-id <id>", "Telegram chat ID to send messages to")
    .option("--label <name>", "Connection label", "default")
    .option(
      "--test",
      "Send a test message first and save the connection only if it arrives",
    )
    .option("--json", "Output as JSON")
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
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
          const token = opts.token.trim();
          const chatId = opts.chatId.trim();
          const problem = connectionInputProblem(token, chatId);
          if (problem) {
            console.error(
              `${chalk.red.bold("✖ Error:")} ${chalk.white(problem)}`,
            );
            process.exit(1);
          }

          loadConnections();

          let testResult: { ok: boolean } | undefined;
          if (opts.test) {
            const sent = await sendMessage(token, chatId, TEST_MESSAGE);
            if (!sent.success) {
              console.error(
                `${chalk.red.bold("✖ Test message failed:")} ${chalk.white(sent.error ?? "unknown error")}`,
              );
              console.error(chalk.gray("  ↳ Nothing was saved.\n"));
              process.exit(1);
            }
            testResult = { ok: true };
          }

          const conn = createConnection(
            token,
            chatId,
            opts.label.trim() || "default",
          );

          if (isJsonOutput(opts)) {
            printJson({
              ...conn,
              bot_token: maskSecret(conn.bot_token),
              test_result: testResult,
            });
          } else {
            printSectionHeader("New Telegram Connection");
            printSuccess("✓ Telegram connection added successfully.\n");

            printKeyValue([
              ["ID", chalk.white.bold(conn.id)],
              ["Label", chalk.cyan(conn.label)],
              ["Chat ID", conn.chat_id],
              ["Token", chalk.gray(maskSecret(conn.bot_token))],
            ]);

            if (testResult) {
              console.log("");
              printSuccess("✓ Test message sent successfully.");
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
    .addOption(
      new Option("--output <format>", "Output format")
        .choices(["table", "json"])
        .default("table"),
    )
    .action(async (opts: { json?: boolean; output?: string }) => {
      try {
        const all = loadConnections();
        if (isJsonOutput(opts)) {
          printJson(
            all.map((c) => ({ ...c, bot_token: maskSecret(c.bot_token) })),
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
            console.log(chalk.dim(`  ${LOCAL_TIME_NOTE}`));
            printTable(all, CONN_COLUMNS);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  telegram
    .command("delete")
    .description("Delete a Telegram connection")
    .argument(
      "<connection-id>",
      "Connection ID from 'revx connector telegram list'",
    )
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
    .command("enable")
    .description("Enable a Telegram connection")
    .argument(
      "<connection-id>",
      "Connection ID from 'revx connector telegram list'",
    )
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
    .command("disable")
    .description("Disable a Telegram connection")
    .argument(
      "<connection-id>",
      "Connection ID from 'revx connector telegram list'",
    )
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
    .command("test")
    .description("Send a test message through a connection")
    .argument(
      "<connection-id>",
      "Connection ID from 'revx connector telegram list'",
    )
    .option("--message <msg>", "Custom test message", TEST_MESSAGE)
    .action(async (connectionId: string, opts: { message: string }) => {
      try {
        const conn = getConnection(connectionId);
        if (!conn) {
          console.error(
            `${chalk.red.bold("✖ Error:")} ${chalk.white(`Connection ${chalk.cyan(connectionId)} not found.`)}`,
          );
          process.exit(1);
        }
        const result = await sendMessage(
          conn.bot_token,
          conn.chat_id,
          opts.message,
        );
        if (result.success) {
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
