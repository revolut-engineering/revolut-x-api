import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./_helpers.js";

export function registerWorkerTools(server: McpServer): void {
  server.registerTool(
    "worker_status",
    {
      title: "Get Worker Status",
      description: "Get the current status of the background alert worker.",
      annotations: { title: "Get Worker Status", readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        const status = (await getWorkerClient().getWorkerStatus()) as Record<string, unknown>;
        const running = status.running ? "RUNNING" : "STOPPED";
        const credsOk = status.credentials_configured as boolean;
        const credsLine = credsOk
          ? "configured"
          : "NOT CONFIGURED — run generate_keypair + configure_api_key";

        return textResult(
          `Worker status: ${running}\n` +
            `  Credentials: ${credsLine}\n` +
            `  Status: ${status.status ?? "unknown"}\n` +
            `  Last tick: ${status.last_tick ?? "never"}\n` +
            `  Last error: ${status.last_error ?? "none"}\n` +
            `  Active alerts: ${status.active_alert_count ?? 0}\n` +
            `  Enabled connections: ${status.enabled_connection_count ?? 0}\n` +
            `  Uptime: ${status.uptime_seconds ?? "N/A"}s`,
        );
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          return textResult(`Worker status: STOPPED (unreachable)\n\n${WORKER_NOT_RUNNING}`);
        }
        if (error instanceof WorkerAPIError) {
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "worker_stop",
    {
      title: "Stop Worker",
      description: "Stop the background alert worker.",
      annotations: { title: "Stop Worker", readOnlyHint: false, destructiveHint: true },
    },
    async () => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");

      try {
        await getWorkerClient().stopWorker();
        return textResult("Worker stop requested.");
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          return textResult("Worker is not running (already stopped).");
        }
        if (error instanceof WorkerAPIError) {
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "worker_restart",
    {
      title: "Restart Worker",
      description: "Restart the background alert worker.",
      annotations: { title: "Restart Worker", readOnlyHint: false, destructiveHint: false },
    },
    async () => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      try {
        await getWorkerClient().restartWorker();
        return textResult("Worker restart requested.");
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          return textResult(`Cannot restart: Worker is not running.\n\n${WORKER_NOT_RUNNING}`);
        }
        if (error instanceof WorkerAPIError) {
          return textResult(`Worker error: ${error.message}`);
        }
        throw error;
      }
    },
  );
}
