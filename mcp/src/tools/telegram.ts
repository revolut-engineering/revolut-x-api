import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, CLI_INSTALL_HINT } from "./_helpers.js";

const VALID_ACTIONS = [
  "add",
  "list",
  "delete",
  "enable",
  "disable",
  "test",
] as const;

export function registerTelegramTools(server: McpServer): void {
  server.registerTool(
    "telegram_command",
    {
      title: "Telegram CLI Command",
      description:
        "Generate a revx CLI command for Telegram connection operations. Supports: add, list, delete, enable, disable, test. " +
        "Returns the exact CLI command to run.",
      inputSchema: {
        action: z
          .enum(VALID_ACTIONS)
          .describe(
            "The telegram operation: add, list, delete, enable, disable, test.",
          ),
        bot_token: z
          .string()
          .optional()
          .describe("Telegram Bot API token (required for add)."),
        chat_id: z
          .string()
          .optional()
          .describe("Telegram chat ID (required for add)."),
        label: z
          .string()
          .optional()
          .describe('Human-readable label (default "default").'),
        connection_id: z
          .string()
          .optional()
          .describe("Connection ID for delete/enable/disable/test operations."),
        message: z
          .string()
          .optional()
          .describe("Custom test message text (for test action)."),
        test_on_add: z
          .boolean()
          .optional()
          .describe("Send a test message after adding (adds --test flag)."),
      },
      annotations: {
        title: "Telegram CLI Command",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({
      action,
      bot_token,
      chat_id,
      label,
      connection_id,
      message,
      test_on_add,
    }) => {
      const act = action;

      switch (act) {
        case "add": {
          if (!bot_token)
            return textResult("Missing required parameter: bot_token.");
          if (!chat_id)
            return textResult("Missing required parameter: chat_id.");

          const parts = [
            "revx telegram add",
            "--token",
            bot_token.trim(),
            "--chat-id",
            chat_id.trim(),
          ];
          if (label && label.trim()) parts.push("--label", `"${label.trim()}"`);
          if (test_on_add) parts.push("--test");

          return textResult(
            `Action: Add a Telegram connection\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `Description: Adds a Telegram bot connection for alert notifications.` +
              CLI_INSTALL_HINT,
          );
        }

        case "list":
          return textResult(
            "Action: List all Telegram connections\n\n" +
              "Command:\n  revx telegram list\n\n" +
              "For JSON output:\n  revx telegram list --json" +
              CLI_INSTALL_HINT,
          );

        case "delete": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          return textResult(
            `Action: Delete Telegram connection ${connection_id}\n\n` +
              `Command:\n  revx telegram delete ${connection_id}` +
              CLI_INSTALL_HINT,
          );
        }

        case "enable": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          return textResult(
            `Action: Enable Telegram connection ${connection_id}\n\n` +
              `Command:\n  revx telegram enable ${connection_id}` +
              CLI_INSTALL_HINT,
          );
        }

        case "disable": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          return textResult(
            `Action: Disable Telegram connection ${connection_id}\n\n` +
              `Command:\n  revx telegram disable ${connection_id}` +
              CLI_INSTALL_HINT,
          );
        }

        case "test": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          const parts = ["revx telegram test", connection_id];
          if (message) parts.push("--message", `"${message}"`);
          return textResult(
            `Action: Test Telegram connection ${connection_id}\n\n` +
              `Command:\n  ${parts.join(" ")}` +
              CLI_INSTALL_HINT,
          );
        }
      }
    },
  );
}
