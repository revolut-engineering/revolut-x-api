import { existsSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./_helpers.js";

export function registerSetupTools(server: McpServer): void {
  server.registerTool(
    "generate_keypair",
    {
      title: "Generate API Keypair",
      description:
        "Generate a new Ed25519 keypair for Revolut X API authentication. Creates a private key (stored securely on your machine) and returns the public key. You must add the public key to your Revolut X account under Profile > API Keys.",
      annotations: {
        title: "Generate API Keypair",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const {
        ensureConfigDir,
        getPrivateKeyFile,
        getPublicKeyFile,
        generateKeypair,
        loadPrivateKey,
        getPublicKeyPem,
      } = await import("api-k9x2a");

      ensureConfigDir();

      const privateKeyPath = getPrivateKeyFile();

      if (existsSync(privateKeyPath)) {
        try {
          const existingKey = loadPrivateKey(privateKeyPath);
          const pubPem = getPublicKeyPem(existingKey);
          return textResult(
            "IMPORTANT: Display the public key below to the user exactly as-is — they need to copy it.\n\n" +
              "A keypair already exists. Here is your existing public key:\n\n" +
              `${pubPem}\n` +
              "If you want to generate a new one, please delete the existing " +
              `key file.\n\n` +
              "Next steps:\n" +
              "1. Copy the public key above (including the BEGIN/END lines)\n" +
              "2. Go to Revolut X → Profile and add the public key\n" +
              "3. Create a new API key and copy it\n" +
              "4. Run 'configure_api_key' with that API key",
          );
        } catch {}
      }

      const publicPem = generateKeypair(privateKeyPath, getPublicKeyFile());

      return textResult(
        "IMPORTANT: Display the public key below to the user exactly as-is — they need to copy it.\n\n" +
          "Ed25519 keypair generated successfully!\n\n" +
          "Here is your PUBLIC key (copy this):\n\n" +
          `${publicPem}\n` +
          "Next steps:\n" +
          "1. Copy the public key above (including the BEGIN/END lines)\n" +
          "2. Go to Revolut X → Profile and add the public key\n" +
          "3. Create a new API key and copy it\n" +
          "4. Run 'configure_api_key' with that API key",
      );
    },
  );

  server.registerTool(
    "configure_api_key",
    {
      title: "Configure API Key",
      description:
        "Save your Revolut X API key. Run this after you have added your public key to your Revolut X account and received an API key.",
      inputSchema: {
        api_key: z
          .string()
          .describe("The 64-character API key from your Revolut X profile."),
      },
      annotations: {
        title: "Configure API Key",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ api_key }) => {
      const { getPrivateKeyFile, loadConfig, saveConfig } =
        await import("api-k9x2a");

      const cleaned = api_key.trim();
      if (!/^[A-Za-z0-9]{64}$/.test(cleaned)) {
        return textResult(
          "Invalid API key format. The API key should be exactly " +
            "64 alphanumeric characters. Please check and try again.",
        );
      }

      if (!existsSync(getPrivateKeyFile())) {
        return textResult(
          "No private key found. Please run 'generate_keypair' first " +
            "to create your authentication keys.",
        );
      }

      const config = loadConfig();
      config.api_key = cleaned;
      config.private_key_path = getPrivateKeyFile();
      saveConfig(config);

      const { resetRevolutXClient } = await import("../server.js");
      resetRevolutXClient();

      return textResult(
        "API key saved successfully!\n\n" +
          "Run 'check_auth_status' to verify your configuration works.",
      );
    },
  );

  server.registerTool(
    "get_cli_install_command",
    {
      title: "Get CLI Install Command",
      description:
        "Returns the command to install the trading CLI tool. Use this whenever the user asks how to install the CLI, the terminal tool, the command-line interface, or wants to use 'revx' commands.",
      annotations: {
        title: "Get CLI Install Command",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      return textResult(
        "To install the CLI, run:\n\n" +
          "  npm install -g cli-k9x2a\n\n" +
          "This installs the 'revx' command globally. The API client is bundled inside — no separate install needed.\n\n" +
          "After installation, run 'revx configure' to set up your API key and keypair.",
      );
    },
  );

  server.registerTool(
    "check_auth_status",
    {
      title: "Check Auth Status",
      description:
        "Check if Revolut X API authentication is configured and working. Tests the connection by fetching available currencies.",
      annotations: {
        title: "Check Auth Status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const { isConfigured, loadCredentials } = await import("api-k9x2a");
      const { SETUP_GUIDE } = await import("../server.js");

      if (!isConfigured()) {
        return textResult(`Not configured.\n\n${SETUP_GUIDE}`);
      }

      const creds = loadCredentials();
      if (creds === null) {
        return textResult(
          `Configuration incomplete or corrupted.\n\n${SETUP_GUIDE}`,
        );
      }

      try {
        const { getRevolutXClient } = await import("../server.js");
        const client = getRevolutXClient();
        const result = await client.getCurrencies();
        const count =
          result && typeof result === "object"
            ? Object.keys(result).length
            : "unknown";
        return textResult(
          "Authentication is configured and working!\n\n" +
            `Successfully connected to Revolut X API.\n` +
            `Available currencies: ${count}\n\n` +
            "You can now use all trading and market data tools.",
        );
      } catch (exc) {
        return textResult(
          `Authentication is configured but the connection test failed:\n` +
            `${exc}\n\n` +
            "Please verify your API key is correct and that the public key " +
            "is registered in your Revolut X account.",
        );
      }
    },
  );
}
