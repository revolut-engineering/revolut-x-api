/**
 * Telegram connection management MCP tools — delegates to Worker service.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./_helpers.js";

export function registerTelegramTools(server: McpServer): void {
  server.registerTool(
    "telegram_add_connection",
    {
      title: "Add Telegram Connection",
      description: "Add a Telegram connection for alert notifications.",
      inputSchema: {
        bot_token: z.string().describe("Telegram Bot API token (from @BotFather)."),
        chat_id: z.string().describe("Telegram chat ID to send messages to."),
        label: z
          .string()
          .default("default")
          .describe('Human-readable label for this connection (default "default").'),
        test: z
          .boolean()
          .default(true)
          .describe("If true, send a test message after adding."),
      },
      annotations: {
        title: "Add Telegram Connection",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ bot_token, chat_id, label, test }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      const body = {
        bot_token: bot_token.trim(),
        chat_id: chat_id.trim(),
        label: label.trim() || "default",
        test,
      };

      try {
        const result = (await getWorkerClient().createConnection(body)) as Record<string, unknown>;
        const connectionId = result.id ?? "?";
        const testResult = result.test_result as Record<string, unknown> | undefined;

        let testMsg = "";
        if (testResult !== undefined) {
          if (testResult.success) {
            testMsg = "\nTest message sent successfully!";
          } else {
            testMsg = `\nTest message FAILED: ${testResult.error ?? "unknown error"}`;
          }
        }

        return textResult(
          `Telegram connection added (id: ${connectionId}, ` +
            `label: '${label || "default"}')${testMsg}`,
        );
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 422)
            return textResult(`Invalid connection configuration: ${error.message}`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "telegram_list_connections",
    {
      title: "List Telegram Connections",
      description: "List all configured Telegram connections.",
      annotations: { title: "List Telegram Connections", readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        const data = (await getWorkerClient().listConnections()) as Record<string, unknown>;
        const connections = (data.data ?? []) as Record<string, unknown>[];

        if (!connections.length) {
          return textResult(
            "No Telegram connections configured. " +
              "Use 'telegram_add_connection' to add one.",
          );
        }

        const lines: string[] = [];
        for (const c of connections) {
          const status = c.enabled ? "enabled" : "disabled";
          lines.push(
            `  ID: ${c.id}\n` +
              `  Label: ${c.label ?? ""}\n` +
              `  Chat ID: ${c.chat_id ?? "?"}\n` +
              `  Token: ${c.bot_token_redacted ?? "***"}\n` +
              `  Status: ${status}\n` +
              `  Last tested: ${c.last_tested_at ?? "never"}\n`,
          );
        }
        return textResult(`Telegram connections (${connections.length}):\n\n` + lines.join("\n"));
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) return textResult(`Worker error: ${error.message}`);
        throw error;
      }
    },
  );

  server.registerTool(
    "telegram_delete_connection",
    {
      title: "Delete Telegram Connection",
      description: "Delete a Telegram connection.",
      inputSchema: {
        connection_id: z.string().describe("ID of the connection to delete."),
      },
      annotations: { title: "Delete Telegram Connection", readOnlyHint: false, destructiveHint: true },
    },
    async ({ connection_id }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        await getWorkerClient().deleteConnection(connection_id);
        return textResult(`Telegram connection ${connection_id} deleted.`);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Connection ${connection_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "telegram_enable_connection",
    {
      title: "Enable Telegram Connection",
      description: "Enable a Telegram connection.",
      inputSchema: {
        connection_id: z.string().describe("ID of the connection to enable."),
      },
      annotations: {
        title: "Enable Telegram Connection",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ connection_id }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        await getWorkerClient().updateConnection(connection_id, { enabled: true });
        return textResult(`Telegram connection ${connection_id} enabled.`);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Connection ${connection_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "telegram_disable_connection",
    {
      title: "Disable Telegram Connection",
      description: "Disable a Telegram connection.",
      inputSchema: {
        connection_id: z.string().describe("ID of the connection to disable."),
      },
      annotations: {
        title: "Disable Telegram Connection",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ connection_id }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        await getWorkerClient().updateConnection(connection_id, { enabled: false });
        return textResult(`Telegram connection ${connection_id} disabled.`);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Connection ${connection_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "telegram_test_connection",
    {
      title: "Test Telegram Connection",
      description: "Send a test message through a Telegram connection.",
      inputSchema: {
        connection_id: z.string().describe("ID of the connection to test."),
        message: z
          .string()
          .default("Test message from RevolutX MCP")
          .describe("Custom test message text."),
      },
      annotations: {
        title: "Test Telegram Connection",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ connection_id, message }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        const result = (await getWorkerClient().testConnection(
          connection_id,
          message,
        )) as Record<string, unknown>;

        if (result.success) {
          return textResult(`Test message sent successfully to connection ${connection_id}.`);
        }
        return textResult(`Test failed: ${result.error ?? "unknown error"}`);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) {
          if (error.statusCode === 404) return textResult(`Connection ${connection_id} not found.`);
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );
}
