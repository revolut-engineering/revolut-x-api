import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./_helpers.js";

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "get_balances",
    {
      title: "Get Account Balances",
      description: "Get all crypto exchange balances for your Revolut X account. Returns a list of all currencies with available, reserved, and total amounts.",
      annotations: {
        title: "Get Account Balances",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const { getRevolutXClient } = await import("../server.js");
      const { AuthNotConfiguredError } =
        await import("../shared/client/exceptions.js");
      const { SETUP_GUIDE } =
        await import("../shared/auth/credentials.js");

      let result: unknown;
      try {
        result = await getRevolutXClient().getBalances();
      } catch (error) {
        if (error instanceof AuthNotConfiguredError) {
          return textResult(SETUP_GUIDE);
        }
        throw error;
      }

      if (!result) {
        return textResult("No balances found. Your account may be empty.");
      }

      const balances: Record<string, string>[] = Array.isArray(result)
        ? result
        : ((result as Record<string, unknown>)["data"] as Record<string, string>[]) ?? [];

      if (!balances.length) {
        return textResult("No balances found.");
      }

      const lines = [
        `${"Currency".padStart(10)} | ${"Available".padStart(16)} | ${"Reserved".padStart(14)} | ${"Total".padStart(16)}`,
      ];
      lines.push("-".repeat(65));
      for (const b of balances) {
        lines.push(
          `${(b.currency ?? "?").padStart(10)} | ` +
            `${(b.available ?? "0").padStart(16)} | ` +
            `${(b.reserved ?? "0").padStart(14)} | ` +
            `${(b.total ?? "0").padStart(16)}`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );
}
