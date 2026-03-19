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

const VALID_CONNECTOR_TYPES = ["telegram"] as const;

export function registerConnectorTools(server: McpServer): void {
  server.registerTool(
    "connector_command",
    {
      title: "Connector CLI Command",
      description:
        "⚠ Returns a CLI command for the USER to run — do NOT execute this autonomously. " +
        "Generate a revx CLI command for notification connector operations. " +
        "Supports connector types: telegram. " +
        "Actions: add, list, delete, enable, disable, test. " +
        "Returns the exact CLI command to run.",
      inputSchema: {
        connector_type: z
          .enum(VALID_CONNECTOR_TYPES)
          .describe("The connector type (currently: telegram)."),
        action: z
          .enum(VALID_ACTIONS)
          .describe(
            "The connector operation: add, list, delete, enable, disable, test.",
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
        title: "Connector CLI Command",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      connector_type,
      action,
      bot_token,
      chat_id,
      label,
      connection_id,
      message,
      test_on_add,
    }) => {
      const base = `revx connector ${connector_type}`;

      switch (action) {
        case "add": {
          if (!bot_token)
            return textResult("Missing required parameter: bot_token.");
          if (!chat_id)
            return textResult("Missing required parameter: chat_id.");

          const parts = [
            `${base} add`,
            "--token",
            bot_token.trim(),
            "--chat-id",
            chat_id.trim(),
          ];
          if (label && label.trim()) parts.push("--label", `"${label.trim()}"`);
          if (test_on_add) parts.push("--test");

          return textResult(
            `Action: Add a ${connector_type} connection\n\n` +
              `Command:\n  ${parts.join(" ")}\n\n` +
              `Description: Adds a ${connector_type} bot connection for alert notifications.` +
              CLI_INSTALL_HINT,
          );
        }

        case "list":
          return textResult(
            `Action: List all ${connector_type} connections\n\n` +
              `Command:\n  ${base} list\n\n` +
              `For JSON output:\n  ${base} list --json` +
              CLI_INSTALL_HINT,
          );

        case "delete": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          return textResult(
            `Action: Delete ${connector_type} connection ${connection_id}\n\n` +
              `Command:\n  ${base} delete ${connection_id}` +
              CLI_INSTALL_HINT,
          );
        }

        case "enable": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          return textResult(
            `Action: Enable ${connector_type} connection ${connection_id}\n\n` +
              `Command:\n  ${base} enable ${connection_id}` +
              CLI_INSTALL_HINT,
          );
        }

        case "disable": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          return textResult(
            `Action: Disable ${connector_type} connection ${connection_id}\n\n` +
              `Command:\n  ${base} disable ${connection_id}` +
              CLI_INSTALL_HINT,
          );
        }

        case "test": {
          if (!connection_id)
            return textResult("Missing required parameter: connection_id.");
          const parts = [`${base} test`, connection_id];
          if (message) parts.push("--message", `"${message}"`);
          return textResult(
            `Action: Test ${connector_type} connection ${connection_id}\n\n` +
              `Command:\n  ${parts.join(" ")}` +
              CLI_INSTALL_HINT,
          );
        }
      }
    },
  );
}
