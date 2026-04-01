import { Command } from "commander";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import chalk from "chalk";
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
} from "api-k9x2a";
import {
  printKeyValue,
  printSuccess,
  printWarning,
} from "../output/formatter.js";
import {
  hasPasskey,
  setPasskey,
  verifyPasskey,
  removePasskey,
} from "../util/passkey.js";
import { promptHiddenInput } from "../util/session.js";

const BANNER = [
  " ____   _____  __     __ __  __ ",
  "|  _ \\ | ____| \\ \\   / / \\ \\/ / ",
  "| |_) ||  _|    \\ \\ / /   \\  /  ",
  "|  _ < | |___    \\ V /    /  \\  ",
  "|_| \\_\\|_____|    \\_/    /_/\\_\\ ",
  " ____   _____  __     __ __  __ ",
].join("\n");

export function registerConfigureCommand(
  program: Command,
  version: string,
): void {
  const configure = program
    .command("configure")
    .description("Manage API credentials and configuration")
    .addHelpText(
      "after",
      `
Examples:
  $ revx configure                          Interactive setup wizard
  $ revx configure get                      Show current configuration
  $ revx configure set --api-key <key>      Set API key
  $ revx configure generate-keypair         Generate Ed25519 keypair
  $ revx configure path                     Print config directory path
  $ revx configure passkey set              Set or change passkey
  $ revx configure passkey remove           Remove passkey
  $ revx configure passkey status           Show passkey status`,
    );

  configure.action(async () => {
    ensureConfigDir();
    const configDir = getConfigDir();

    console.log(chalk.cyan(BANNER));
    console.log(
      chalk.bold.white(" :: Revolut X  ·  Setup Wizard") +
        chalk.dim(`  (v${version})`),
    );
    console.log(chalk.dim("─".repeat(44)));
    console.log(
      `${chalk.bold("Config Directory:")} ${chalk.cyan(configDir)}\n`,
    );

    printSection("Keypair");
    const privateKeyPath = getPrivateKeyFile();
    if (!existsSync(privateKeyPath)) {
      const publicKeyPem = generateKeypair(privateKeyPath, getPublicKeyFile());
      printSuccess("✓ Ed25519 keypair successfully generated.\n");

      console.log(
        chalk.bold.yellow(
          "Action Required: Register this public key with Revolut X\n",
        ),
      );
      console.log(chalk.gray(publicKeyPem));
      console.log(chalk.white.bold("Steps:"));
      console.log(
        chalk.dim("  1. ") + "Copy the key above (including BEGIN/END lines)",
      );
      console.log(
        chalk.dim("  2. ") + "Go to Revolut X → Profile → Add public key",
      );
      console.log(chalk.dim("  3. ") + "Create a new API key and copy it");
    } else {
      const existingKey = loadPrivateKey(privateKeyPath);
      const pubPem = getPublicKeyPem(existingKey);

      console.log(chalk.green("✓ Private key already configured.\n"));
      console.log(chalk.bold.white("Your associated public key:\n"));
      console.log(chalk.gray(pubPem));
      console.log(chalk.white.bold("Steps (if not yet registered):"));
      console.log(
        chalk.dim("  1. ") + "Copy the key above (including BEGIN/END lines)",
      );
      console.log(
        chalk.dim("  2. ") + "Go to Revolut X → Profile → Add public key",
      );
    }

    printSection("API Key");
    const existing = loadConfig();
    if (existing.api_key) {
      console.log(
        `${chalk.green("✓ API Key already configured:")} ${chalk.cyan(maskKey(existing.api_key))}`,
      );
      console.log(chalk.dim("  (Press Enter to keep existing)\n"));
    } else {
      console.log(chalk.yellow("! No API Key configured.\n"));
    }

    while (true) {
      const apiKey = await promptHiddenInput(
        chalk.bold.cyan("❯ Enter API Key ") + chalk.dim("(input hidden): "),
      );
      const trimmed = apiKey.trim();

      if (!trimmed) {
        if (existing.api_key) {
          console.log(chalk.dim("  API key unchanged."));
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
        printSuccess("✓ API key saved.");
        break;
      }
      printWarning(
        "Invalid API key format. Must be exactly 64 alphanumeric characters.",
      );
    }

    console.log("");
    await setupPasskeyInteractive();

    console.log("");
    console.log(chalk.dim("─".repeat(44)));
    if (isConfigured()) {
      printSuccess(
        "✓ Configuration complete! Run 'revx --help' to see available commands.",
      );
    } else {
      printWarning(
        "! Configuration incomplete. Run 'revx configure' again when ready.",
      );
    }
  });

  configure
    .command("get")
    .description("Show current configuration")
    .action(() => {
      const config = loadConfig();
      const formatState = (isSet: boolean) =>
        isSet ? chalk.green("configured") : chalk.dim("(not set)");

      const entries: [string, string][] = [
        ["Config directory", chalk.cyan(getConfigDir())],
        [
          "API key",
          config.api_key
            ? chalk.cyan(maskKey(config.api_key))
            : chalk.dim("(not set)"),
        ],
        ["Private key", formatState(existsSync(getPrivateKeyFile()))],
        ["Public key", formatState(existsSync(getPublicKeyFile()))],
        ["Passkey", formatState(hasPasskey())],
        ["Configured", isConfigured() ? chalk.green("yes") : chalk.red("no")],
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
            chalk.red(
              "✖ Invalid API key format. Must be exactly 64 alphanumeric characters.",
            ),
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
        printSuccess("✓ API key saved.");
      } else {
        console.error(chalk.red("✖ No option provided. Use --api-key <key>."));
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
      printSuccess("✓ Keypair generated.\n");
      console.log(
        chalk.bold.yellow("Register this public key with Revolut X:\n"),
      );
      console.log(chalk.gray(publicKeyPem));
    });

  configure
    .command("path")
    .description("Print configuration directory path")
    .action(() => {
      console.log(chalk.cyan(getConfigDir()));
    });

  const passkey = configure
    .command("passkey")
    .description("Manage the write-operation passkey");

  passkey
    .command("set")
    .description("Set or change the passkey")
    .action(async () => {
      ensureConfigDir();
      if (hasPasskey()) {
        const current = await promptHiddenInput(
          chalk.bold.cyan("❯ Current passkey: "),
        );
        if (!verifyPasskey(current)) {
          console.error(chalk.red("✖ Error: Incorrect passkey."));
          process.exit(1);
        }
      }
      await setNewPasskey();
      printSuccess("✓ Passkey updated.");
    });

  passkey
    .command("remove")
    .description(
      "Remove passkey (write operations will proceed without passkey protection)",
    )
    .action(async () => {
      if (!hasPasskey()) {
        printWarning("No passkey configured.");
        return;
      }
      const current = await promptHiddenInput(
        chalk.bold.cyan("❯ Current passkey: "),
      );
      if (!verifyPasskey(current)) {
        console.error(chalk.red("✖ Error: Incorrect passkey."));
        process.exit(1);
      }
      removePasskey();
      printSuccess("✓ Passkey removed.");
    });

  passkey
    .command("status")
    .description("Show passkey configuration status")
    .action(() => {
      printKeyValue([
        [
          "Passkey",
          hasPasskey() ? chalk.green("configured") : chalk.dim("(not set)"),
        ],
      ]);
    });
}

async function setupPasskeyInteractive(): Promise<void> {
  printSection("Passkey");
  console.log(chalk.white("Protects write operations (orders, bots)."));
  console.log(chalk.dim("Input is hidden.\n"));

  if (hasPasskey()) {
    console.log(chalk.green("✓ Passkey already configured."));
    console.log(chalk.dim("  (Press Enter to keep existing)\n"));

    while (true) {
      const input = await promptHiddenInput(
        chalk.bold.cyan("❯ Enter new passkey ") +
          chalk.dim("(leave blank to keep existing): "),
      );
      if (!input.trim()) {
        console.log(chalk.dim("  Passkey unchanged."));
        return;
      }
      const confirm = await promptHiddenInput(
        chalk.bold.cyan("❯ Confirm new passkey: "),
      );
      if (!safeStringEqual(input, confirm)) {
        printWarning("Passphrases do not match. Try again.\n");
        continue;
      }
      setPasskey(input);
      printSuccess("✓ Passkey updated.");
      return;
    }
  }

  console.log(chalk.yellow("! No Passkey configured.\n"));
  while (true) {
    const input = await promptHiddenInput(
      chalk.bold.cyan("❯ Enter passkey ") +
        chalk.dim("(optional, leave blank to skip): "),
    );
    if (!input.trim()) {
      console.log(chalk.dim("  Passkey setup skipped."));
      return;
    }
    const confirm = await promptHiddenInput(
      chalk.bold.cyan("❯ Confirm passkey: "),
    );
    if (!safeStringEqual(input, confirm)) {
      printWarning("Passphrases do not match. Try again.\n");
      continue;
    }
    setPasskey(input);
    printSuccess("✓ Passkey configured.");
    return;
  }
}

async function setNewPasskey(): Promise<void> {
  while (true) {
    const input = await promptHiddenInput(chalk.bold.cyan("❯ New passkey: "));
    if (!input.trim()) {
      printWarning("Passkey cannot be empty.\n");
      continue;
    }
    const confirm = await promptHiddenInput(
      chalk.bold.cyan("❯ Confirm passkey: "),
    );
    if (!safeStringEqual(input, confirm)) {
      printWarning("Passphrases do not match. Try again.\n");
      continue;
    }
    setPasskey(input);
    return;
  }
}

function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

function printSection(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  console.log(chalk.dim("─".repeat(44)));
}
