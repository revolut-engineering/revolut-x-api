import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./_helpers.js";

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "get_balances",
    {
      title: "Get Account Balances",
      description:
        "Get all crypto exchange balances for your Revolut X account. Returns a list of all currencies with available, reserved, and total amounts.",
      annotations: {
        title: "Get Account Balances",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const { getRevolutXClient, SETUP_GUIDE } = await import("../server.js");
      const { AuthNotConfiguredError } = await import("revolutx-api");

      let balances;
      try {
        balances = await getRevolutXClient().getBalances();
      } catch (error) {
        if (error instanceof AuthNotConfiguredError) {
          return textResult(SETUP_GUIDE);
        }
        throw error;
      }

      if (!balances.length) {
        return textResult("No balances found.");
      }

      const lines = [
        `${"Currency".padStart(10)} | ${"Available".padStart(16)} | ${"Reserved".padStart(14)} | ${"Staked".padStart(14)} | ${"Total".padStart(16)}`,
      ];
      lines.push("-".repeat(65));
      for (const b of balances) {
        lines.push(
          `${b.currency.padStart(10)} | ` +
            `${b.available.padStart(16)} | ` +
            `${b.reserved.padStart(14)} | ` +
            `${(b.staked ?? "0").padStart(14)} | ` +
            `${b.total.padStart(16)}`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );
}
