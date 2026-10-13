import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  credentialsAdvice,
  handleApiError,
  textResult,
  errorResult,
} from "../shared/_helpers.js";

const NEXT_STEPS =
  "Next steps — present ALL of these to the user as a numbered list. Do NOT skip or rephrase any step:\n" +
  "1. Copy the public key above (including the BEGIN/END lines)\n" +
  "2. Go to Revolut X → Profile → API Keys\n" +
  "3. Add the public key\n" +
  "4. Create a new API key — IMPORTANT: tick the 'Allow usage via Revolut X MCP and CLI' checkbox\n" +
  "5. Copy the resulting API key and paste it back here\n\n" +
  "Once the user provides the API key, run 'configure_api_key' with it.";

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
        generateKeypair,
        getPublicKeyPem,
        inspectPrivateKey,
        loadConfig,
        moveKeypairAside,
        publicKeyFileFor,
        redactHome,
        resolvePrivateKeyFile,
        InsecureKeyPermissionsError,
      } = await import("@revolut/revolut-x-api");
      const { SETUP_GUIDE, resetRevolutXClient } = await import("../server.js");

      let privateKeyPath: string;
      try {
        ensureConfigDir();
        privateKeyPath = resolvePrivateKeyFile(loadConfig().private_key_path);
      } catch (exc) {
        const handled = await handleApiError(exc, SETUP_GUIDE);
        if (handled) return handled;
        return errorResult(
          `Could not create the keypair: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }

      let missing = false;
      let replace = false;
      try {
        const key = inspectPrivateKey(privateKeyPath);
        if (key.status === "ready") {
          return textResult(
            "IMPORTANT: Display the public key below to the user exactly as-is — they need to copy it.\n\n" +
              "A keypair already exists. Here is your existing public key:\n\n" +
              `${getPublicKeyPem(key.privateKey)}\n` +
              `To make a new key pair instead, ask the user to move ${redactHome(privateKeyPath)} aside first.\n\n` +
              NEXT_STEPS,
          );
        }
        const { issue } = key;
        if (issue.fault === "unreadable" || issue.fault === "not_a_file") {
          return errorResult(await credentialsAdvice(issue, SETUP_GUIDE));
        }
        missing = issue.fault === "missing";
        replace = issue.fault === "malformed";
      } catch (exc) {
        if (!(exc instanceof InsecureKeyPermissionsError)) throw exc;
        replace = true;
      }

      let moved: string | undefined;
      let publicPem: string;
      try {
        moved = replace
          ? moveKeypairAside(privateKeyPath, publicKeyFileFor(privateKeyPath))
          : undefined;
        const newKeyPath = missing ? getPrivateKeyFile() : privateKeyPath;
        publicPem = generateKeypair(newKeyPath, publicKeyFileFor(newKeyPath));
      } catch (exc) {
        return errorResult(
          (moved
            ? `The old private key was moved to ${redactHome(moved)}. `
            : "") +
            `Could not create the keypair: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
      resetRevolutXClient();

      return textResult(
        "IMPORTANT: Display the public key below to the user exactly as-is — they need to copy it.\n\n" +
          (moved
            ? `The old private key was moved to ${redactHome(moved)}. It is no longer used.\n\n`
            : "") +
          "Ed25519 keypair generated successfully!\n\n" +
          "Here is your PUBLIC key (copy this):\n\n" +
          `${publicPem}\n` +
          NEXT_STEPS,
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
      const {
        inspectCredentials,
        inspectPrivateKey,
        loadConfig,
        resolvePrivateKeyFile,
        saveConfig,
      } = await import("@revolut/revolut-x-api");
      const { SETUP_GUIDE, resetRevolutXClient } = await import("../server.js");

      const cleaned = api_key.trim();
      if (!/^[A-Za-z0-9]{64}$/.test(cleaned)) {
        return errorResult(
          "Invalid API key format. The API key should be exactly " +
            "64 alphanumeric characters. Please check and try again.",
        );
      }

      try {
        const check = inspectCredentials();
        if (
          check.status === "invalid" &&
          check.issue.file === "config" &&
          check.issue.fault !== "malformed"
        ) {
          return errorResult(await credentialsAdvice(check.issue, SETUP_GUIDE));
        }
        const config = loadConfig();
        const privateKeyPath = resolvePrivateKeyFile(config.private_key_path);
        const key = inspectPrivateKey(privateKeyPath);
        if (key.status === "invalid") {
          return errorResult(
            key.issue.fault === "missing"
              ? "No private key found. Please run 'generate_keypair' first to create your authentication keys."
              : await credentialsAdvice(key.issue, SETUP_GUIDE),
          );
        }
        saveConfig({
          ...config,
          api_key: cleaned,
          private_key_path: privateKeyPath,
        });
      } catch (exc) {
        const handled = await handleApiError(exc, SETUP_GUIDE);
        if (handled) return handled;
        throw exc;
      }

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
          "  npm install -g @revolut/revolut-x-cli\n\n" +
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
        "Check whether Revolut X API authentication is configured and the connection is working.",
      annotations: {
        title: "Check Auth Status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const {
        inspectCredentials,
        AuthenticationError,
        ForbiddenError,
        NetworkError,
      } = await import("@revolut/revolut-x-api");
      const { SETUP_GUIDE, getRevolutXClient, resetRevolutXClient } =
        await import("../server.js");

      let check: ReturnType<typeof inspectCredentials>;
      try {
        check = inspectCredentials();
      } catch (exc) {
        const handled = await handleApiError(exc, SETUP_GUIDE);
        if (handled) return textResult(handled.content[0].text);
        throw exc;
      }
      if (check.status === "missing") {
        return textResult(`Not configured.\n\n${SETUP_GUIDE}`);
      }
      if (check.status === "invalid") {
        return textResult(await credentialsAdvice(check.issue, SETUP_GUIDE));
      }

      resetRevolutXClient();
      try {
        await getRevolutXClient().getCurrencies();
        return textResult(
          "Authentication is configured and the connection is working. " +
            "You can now use the data tools.",
        );
      } catch (exc) {
        if (
          exc instanceof AuthenticationError ||
          exc instanceof ForbiddenError
        ) {
          return textResult(
            `Authentication is configured but the exchange refused it:\n${exc.message}\n\n` +
              "Please verify your API key is correct and that the public key " +
              "is registered in your Revolut X account.",
          );
        }
        if (exc instanceof NetworkError) {
          return textResult(
            `Authentication is configured but the exchange could not be reached:\n${exc.message}`,
          );
        }
        const handled = await handleApiError(exc, SETUP_GUIDE);
        if (handled) return textResult(handled.content[0].text);
        return textResult(
          `Authentication is configured but the connection test failed:\n${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
    },
  );
}
