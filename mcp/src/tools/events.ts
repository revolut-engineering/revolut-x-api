/**
 * Event history MCP tools — delegates to Worker service.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./_helpers.js";

export function registerEventTools(server: McpServer): void {
  server.registerTool(
    "events_list",
    {
      title: "List Events",
      description: "List alert trigger history and worker events.",
      inputSchema: {
        category: z
          .string()
          .default("")
          .describe('Filter by event category (e.g. "alert_triggered", "worker"). Leave empty for all.'),
        limit: z
          .number()
          .default(50)
          .describe("Max events to return (1-500, default 50)."),
        offset: z
          .number()
          .default(0)
          .describe("Pagination offset (default 0)."),
      },
      annotations: { title: "List Events", readOnlyHint: true, destructiveHint: false },
    },
    async ({ category, limit, offset }) => {
      const { getWorkerClient } = await import("../server.js");
      const { WorkerUnavailableError, WorkerAPIError } =
        await import("../shared/client/exceptions.js");
      const { WORKER_NOT_RUNNING } =
        await import("../shared/client/worker-client.js");

      const params: Record<string, unknown> = {
        limit: Math.min(Math.max(1, limit), 500),
        offset: Math.max(0, offset),
      };
      if (category.trim()) {
        params.category = category.trim();
      }

      try {
        const data = (await getWorkerClient().listEvents(params)) as Record<string, unknown>;
        const events = (data.data ?? []) as Record<string, unknown>[];
        const total = (data.total ?? events.length) as number;

        if (!events.length) {
          return textResult("No events found.");
        }

        const lines: string[] = [];
        for (const e of events) {
          const details = (e.details ?? {}) as Record<string, unknown>;
          const detailStr = Object.keys(details).length
            ? Object.entries(details)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")
            : "";
          lines.push(
            `  [${e.ts ?? "?"}] ${e.category ?? "?"}` +
              (detailStr ? `: ${detailStr}` : ""),
          );
        }

        let header = `Events (${events.length} of ${total})`;
        if (params.category) {
          header += ` [category=${params.category}]`;
        }
        return textResult(header + "\n\n" + lines.join("\n"));
      } catch (error) {
        if (error instanceof WorkerUnavailableError) return textResult(WORKER_NOT_RUNNING);
        if (error instanceof WorkerAPIError) return textResult(`Worker error: ${error.message}`);
        throw error;
      }
    },
  );
}
