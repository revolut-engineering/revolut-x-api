import { Command } from "commander";
import { statSync } from "node:fs";
import chalk from "chalk";
import {
  getConfigDir,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  inspectCredentials,
  inspectPrivateKey,
  resolvePrivateKeyFile,
  moveKeypairAside,
  publicKeyFileFor,
  generateKeypair,
  getPublicKeyPem,
  getPrivateKeyFile,
  getPublicKeyFile,
  redactHome,
  isMissing,
  type CredentialsIssue,
  type RevolutXConfig,
} from "@revolut/revolut-x-api";
import {
  printKeyValue,
  printSuccess,
  printWarning,
} from "../output/formatter.js";
import { confirm, promptHiddenInput } from "../util/session.js";
import { credentialsHint } from "../util/credentials-hint.js";
import { handleError } from "../util/errors.js";
import { maskSecret } from "../util/mask.js";

const API_KEY_FORMAT = /^[A-Za-z0-9]{64}$/;

type CredentialsState =
  | { ready: true }
  | { ready: false; issue?: CredentialsIssue; problem?: string };

function credentialsState(): CredentialsState {
  try {
    const check = inspectCredentials();
    if (check.status === "ready") return { ready: true };
    if (check.status === "missing") return { ready: false };
    return { ready: false, issue: check.issue, problem: check.issue.problem };
  } catch (err) {
    return {
      ready: false,
      problem: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeFile(path: string): string {
  try {
    statSync(path);
    return chalk.green("configured");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? chalk.dim("(not set)")
      : chalk.yellow(`(can't check, ${code})`);
  }
}

function describeCredentials(): string {
  const state = credentialsState();
  if (state.ready) return chalk.green("yes");
  return chalk.red(state.problem ? `no: ${state.problem}` : "no");
}

function reportIssue(issue: CredentialsIssue): void {
  console.error(`${chalk.red.bold("✖ Error:")} ${chalk.white(issue.problem)}`);
  console.error(chalk.gray(`  ↳ ${credentialsHint(issue)}\n`));
}

const BANNER = [
  " ____   _____  __     __ __  __ ",
  "|  _ \\ | ____| \\ \\   / / \\ \\/ / ",
  "| |_) ||  _|    \\ \\ / /   \\  /  ",
  "|  _ < | |___    \\ V /    /  \\  ",
  "|_| \\_\\|_____|    \\_/    /_/\\_\\ ",
  " ____   _____  __     __ __  __ ",
].join("\n");

const REGISTER_STEPS = [
  "Copy the key above (including BEGIN/END lines)",
  "Go to Revolut X → Profile → Add public key",
  "Create a new API key — tick 'Allow usage via Revolut X MCP and CLI'",
];

function printRegisterSteps(heading: string): void {
  console.log(chalk.white.bold(heading));
  REGISTER_STEPS.forEach((step, index) => {
    console.log(chalk.dim(`  ${index + 1}. `) + step);
  });
}

interface Keypair {
  privateKeyPath: string;
  created: boolean;
}

async function setUpKeypair(privateKeyPath: string): Promise<Keypair | null> {
  const key = inspectPrivateKey(privateKeyPath);
  if (key.status === "ready") {
    console.log(chalk.green("✓ Private key already configured.\n"));
    console.log(chalk.bold.white("Your associated public key:\n"));
    console.log(chalk.gray(getPublicKeyPem(key.privateKey)));
    printRegisterSteps("Steps (if not yet registered):");
    return { privateKeyPath, created: false };
  }
  const { issue } = key;
  if (issue.fault === "unreadable" || issue.fault === "not_a_file") {
    reportIssue(issue);
    return null;
  }
  if (issue.fault === "malformed") {
    printWarning(`! ${issue.problem}`);
    if (!(await confirm("Move it aside and make a new key pair?"))) {
      console.log(chalk.dim("  Nothing changed."));
      return null;
    }
    const moved = moveKeypairAside(
      privateKeyPath,
      publicKeyFileFor(privateKeyPath),
    );
    console.log(chalk.dim(`  The old key is now at ${redactHome(moved)}.\n`));
  }

  const keyPath =
    issue.fault === "missing" ? getPrivateKeyFile() : privateKeyPath;
  const publicKeyPem = generateKeypair(keyPath, publicKeyFileFor(keyPath));
  printSuccess("✓ Ed25519 keypair successfully generated.\n");
  console.log(
    chalk.bold.yellow(
      "Action Required: Register this public key with Revolut X\n",
    ),
  );
  console.log(chalk.gray(publicKeyPem));
  printRegisterSteps("Steps:");
  return { privateKeyPath: keyPath, created: true };
}

async function setUpApiKey(
  config: RevolutXConfig,
  keypair: Keypair,
): Promise<boolean> {
  const trimmedKey = config.api_key?.trim() ?? "";
  const savedKey = API_KEY_FORMAT.test(trimmedKey) ? trimmedKey : undefined;
  if (savedKey && keypair.created) {
    printWarning(
      "! The saved API key was made for the old key pair. After adding the new public key, create a new API key and enter it here.\n",
    );
  } else if (savedKey) {
    console.log(
      `${chalk.green("✓ API Key already configured:")} ${chalk.cyan(maskSecret(savedKey))}`,
    );
    console.log(chalk.dim("  (Press Enter to keep existing)\n"));
  } else {
    console.log(chalk.yellow("! No API Key configured.\n"));
  }

  while (true) {
    const answer = await promptHiddenInput(
      chalk.bold.cyan("❯ Enter API Key ") + chalk.dim("(input hidden): "),
    );
    const trimmed = (answer ?? "").trim();

    if (!trimmed) {
      if (savedKey) {
        console.log(chalk.dim("  API key unchanged."));
      } else {
        printWarning(
          "No API key set. You can set it later with: revx configure set --api-key <key>",
        );
      }
      return false;
    }
    if (API_KEY_FORMAT.test(trimmed)) {
      saveConfig({
        ...config,
        api_key: trimmed,
        private_key_path: keypair.privateKeyPath,
      });
      printSuccess("✓ API key saved.");
      return true;
    }
    printWarning(
      "Invalid API key format. Must be exactly 64 alphanumeric characters.",
    );
  }
}

function printOutcome(keypair: Keypair, apiKeySaved: boolean): void {
  console.log("");
  console.log(chalk.dim("─".repeat(44)));
  const state = credentialsState();
  if (state.ready && (apiKeySaved || !keypair.created)) {
    printSuccess(
      "✓ Configuration complete! Run 'revx --help' to see available commands.",
    );
    return;
  }
  process.exitCode = 1;
  if (state.ready) {
    printWarning(
      "! Register the new public key with Revolut X, create an API key for it and save it with: revx configure set --api-key <key>",
    );
  } else if (state.issue) {
    printWarning(`! ${state.issue.problem} ${credentialsHint(state.issue)}`);
  } else if (state.problem) {
    printWarning(`! ${state.problem}`);
  } else {
    printWarning(
      "! Configuration incomplete. Run 'revx configure' again when ready.",
    );
  }
}

async function runWizard(version: string): Promise<void> {
  ensureConfigDir();
  const configDir = getConfigDir();

  console.log(chalk.cyan(BANNER));
  console.log(
    chalk.bold.white(" :: Revolut X  ·  Setup Wizard") +
      chalk.dim(`  (v${version})`),
  );
  console.log(chalk.dim("─".repeat(44)));
  console.log(`${chalk.bold("Config Directory:")} ${chalk.cyan(configDir)}\n`);

  const state = credentialsState();
  const configIssue =
    !state.ready && state.issue?.file === "config" ? state.issue : undefined;
  if (configIssue && configIssue.fault !== "malformed") {
    reportIssue(configIssue);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();

  printSection("Keypair");
  const keypair = await setUpKeypair(
    resolvePrivateKeyFile(config.private_key_path),
  );
  if (!keypair) {
    process.exitCode = 1;
    return;
  }

  printSection("API Key");
  if (configIssue) {
    printWarning(`! ${configIssue.problem} Saving an API key replaces it.\n`);
  }
  const apiKeySaved = await setUpApiKey(config, keypair);
  printOutcome(keypair, apiKeySaved);
}

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

The API key must be exactly 64 alphanumeric characters. Private keys stay on this
machine. Only the public key is registered with Revolut X.`,
    );

  configure.action(async () => {
    try {
      await runWizard(version);
    } catch (err) {
      handleError(err);
    }
  });

  configure
    .command("get")
    .description("Show current configuration")
    .action(() => {
      let config: RevolutXConfig = {};
      let configReadable = true;
      try {
        config = loadConfig();
      } catch {
        configReadable = false;
      }
      const state = credentialsState();
      const configIssue = !state.ready && state.issue?.file === "config";
      const formatState = (isSet: boolean) =>
        isSet ? chalk.green("configured") : chalk.dim("(not set)");
      const privateKeyPath = resolvePrivateKeyFile(config.private_key_path);
      const keyLocation =
        privateKeyPath === getPrivateKeyFile()
          ? ""
          : chalk.dim(` ${redactHome(privateKeyPath)}`);

      const entries: [string, string][] = [
        ["Config directory", chalk.cyan(getConfigDir())],
        [
          "API key",
          !configReadable || configIssue
            ? chalk.red("(config file can't be used)")
            : config.api_key
              ? chalk.cyan(maskSecret(config.api_key.trim()))
              : chalk.dim("(not set)"),
        ],
        ["Private key", formatState(!isMissing(privateKeyPath)) + keyLocation],
        ["Public key", describeFile(publicKeyFileFor(privateKeyPath))],
        ["Configured", describeCredentials()],
      ];
      printKeyValue(entries);
      if (!state.ready && state.issue) {
        console.log(chalk.gray(`  ↳ ${credentialsHint(state.issue)}`));
      }
    });

  configure
    .command("set")
    .description("Set configuration values")
    .option("--api-key <key>", "Set API key")
    .action((opts: { apiKey?: string }) => {
      if (!opts.apiKey) {
        console.error(chalk.red("✖ No option provided. Use --api-key <key>."));
        process.exit(1);
      }
      const cleaned = opts.apiKey.trim();
      if (!API_KEY_FORMAT.test(cleaned)) {
        console.error(
          chalk.red(
            "✖ Invalid API key format. Must be exactly 64 alphanumeric characters.",
          ),
        );
        process.exit(1);
      }
      try {
        ensureConfigDir();
        const existing = loadConfig();
        saveConfig({
          ...existing,
          api_key: cleaned,
          private_key_path: resolvePrivateKeyFile(existing.private_key_path),
        });
      } catch (err) {
        handleError(err);
      }
      printSuccess("✓ API key saved.");
    });

  configure
    .command("generate-keypair")
    .description("Generate Ed25519 keypair for API authentication")
    .action(() => {
      const privateKeyPath = getPrivateKeyFile();
      let publicKeyPem: string;
      try {
        ensureConfigDir();
        if (!isMissing(privateKeyPath)) {
          printWarning(
            `A private key already exists at ${redactHome(privateKeyPath)}. To replace a broken key, run 'revx configure'.`,
          );
          process.exit(1);
        }
        publicKeyPem = generateKeypair(privateKeyPath, getPublicKeyFile());
      } catch (err) {
        handleError(err);
      }
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
}

function printSection(title: string): void {
  console.log(chalk.cyan.bold(`\n❖ ${title}`));
  console.log(chalk.dim("─".repeat(44)));
}
