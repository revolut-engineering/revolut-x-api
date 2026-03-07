import { Command } from "commander";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  getConfigDir,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  isConfigured,
  generateKeypair,
  loadPrivateKey,
  getPublicKeyPem,
  getPrivateKeyFile,
  getPublicKeyFile,
} from "revolutx-api";
import {
  printKeyValue,
  printSuccess,
  printWarning,
} from "../output/formatter.js";

export function registerConfigureCommand(program: Command): void {
  const configure = program
    .command("configure")
    .description("Manage API credentials and configuration")
    .addHelpText(
      "after",
      `
Examples:
  $ revx configure                     Interactive setup wizard
  $ revx configure get                 Show current configuration
  $ revx configure set --api-key <key> Set API key
  $ revx configure generate-keypair    Generate Ed25519 keypair
  $ revx configure path                Print config directory path`,
    );

  configure.action(async () => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      ensureConfigDir();
      const configDir = getConfigDir();
      console.log(`Configuration directory: ${configDir}\n`);

      const privateKeyPath = getPrivateKeyFile();
      if (!existsSync(privateKeyPath)) {
        const publicKeyPem = generateKeypair(
          privateKeyPath,
          getPublicKeyFile(),
        );
        printSuccess("Ed25519 keypair generated.\n");
        console.log("Here is your PUBLIC key (copy this):\n");
        console.log(publicKeyPem);
        console.log("Next steps:");
        console.log(
          "  1. Copy the public key above (including the BEGIN/END lines)",
        );
        console.log("  2. Go to Revolut X → Profile and add the public key");
        console.log("  3. Create a new API key and copy it");
        console.log("  4. Paste the API key below\n");
      } else {
        const existingKey = loadPrivateKey(privateKeyPath);
        const pubPem = getPublicKeyPem(existingKey);
        console.log("Private key already configured.\n");
        console.log("Your public key (for reference):\n");
        console.log(pubPem);
        console.log("If you haven't registered it yet:");
        console.log(
          "  1. Copy the public key above (including the BEGIN/END lines)",
        );
        console.log("  2. Go to Revolut X → Profile and add the public key\n");
      }

      const existing = loadConfig();
      while (true) {
        const apiKey = await rl.question(
          `API Key${existing.api_key ? ` [${maskKey(existing.api_key)}]` : ""}: `,
        );
        const trimmed = apiKey.trim();
        if (!trimmed) {
          if (existing.api_key) {
            console.log("API key unchanged.");
          } else {
            printWarning(
              "No API key set. You can set it later with: revx configure set --api-key <key>",
            );
          }
          break;
        }
        if (/^[A-Za-z0-9]{64}$/.test(trimmed)) {
          saveConfig({
            ...existing,
            api_key: trimmed,
            private_key_path: getPrivateKeyFile(),
          });
          printSuccess("API key saved.");
          break;
        }
        printWarning(
          "Invalid API key format. Must be exactly 64 alphanumeric characters.",
        );
      }

      console.log("");
      if (isConfigured()) {
        printSuccess(
          "Configuration complete. Run 'revx --help' to see available commands.",
        );
      } else {
        printWarning(
          "Configuration incomplete. Run 'revx configure' again when ready.",
        );
      }
    } finally {
      rl.close();
    }
  });

  configure
    .command("get")
    .description("Show current configuration")
    .action(() => {
      const config = loadConfig();
      const entries: [string, string][] = [
        ["Config directory", getConfigDir()],
        ["API key", config.api_key ? maskKey(config.api_key) : "(not set)"],
        [
          "Private key",
          existsSync(getPrivateKeyFile()) ? "configured" : "(not set)",
        ],
        [
          "Public key",
          existsSync(getPublicKeyFile()) ? "configured" : "(not set)",
        ],
        ["Configured", isConfigured() ? "yes" : "no"],
      ];
      printKeyValue(entries);
    });

  configure
    .command("set")
    .description("Set configuration values")
    .option("--api-key <key>", "Set API key")
    .action((opts: { apiKey?: string }) => {
      if (opts.apiKey) {
        const cleaned = opts.apiKey.trim();
        if (!/^[A-Za-z0-9]{64}$/.test(cleaned)) {
          console.error(
            "Invalid API key format. Must be exactly 64 alphanumeric characters.",
          );
          process.exit(1);
        }
        ensureConfigDir();
        const existing = loadConfig();
        saveConfig({
          ...existing,
          api_key: cleaned,
          private_key_path: getPrivateKeyFile(),
        });
        printSuccess("API key saved.");
      } else {
        console.error("No option provided. Use --api-key <key>.");
        process.exit(1);
      }
    });

  configure
    .command("generate-keypair")
    .description("Generate Ed25519 keypair for API authentication")
    .action(() => {
      ensureConfigDir();
      const privateKeyPath = getPrivateKeyFile();
      if (existsSync(privateKeyPath)) {
        printWarning(
          "Private key already exists. Delete it first to regenerate.",
        );
        process.exit(1);
      }
      const publicKeyPem = generateKeypair(privateKeyPath, getPublicKeyFile());
      printSuccess("Keypair generated.\n");
      console.log("Register this public key with Revolut X:\n");
      console.log(publicKeyPem);
    });

  configure
    .command("path")
    .description("Print configuration directory path")
    .action(() => {
      console.log(getConfigDir());
    });
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
