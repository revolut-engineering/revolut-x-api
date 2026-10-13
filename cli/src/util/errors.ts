import {
  RevolutXError,
  AuthenticationError,
  AuthNotConfiguredError,
  InvalidCredentialsError,
  RateLimitError,
  BadRequestError,
  NotFoundError,
  NetworkError,
  ForbiddenError,
  ValidationError,
} from "@revolut/revolut-x-api";
import chalk from "chalk";
import { credentialsHint } from "./credentials-hint.js";
import { retryFailure } from "./order-outcome.js";

const ERROR_PREFIX = chalk.red.bold("✖ Error:");

function validationIssues(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((issue: { path?: unknown; message?: unknown }) => {
    const field = Array.isArray(issue.path) ? issue.path.join(".") : "";
    const message = String(issue.message ?? "is not valid");
    return field ? `${field}: ${message}` : message;
  });
}

export function handleError(err: unknown): never {
  if (err instanceof InvalidCredentialsError) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}`);
    console.error(chalk.gray(`  ↳ ${credentialsHint(err.issue)}\n`));
    process.exit(1);
  }

  if (err instanceof AuthNotConfiguredError) {
    console.error(`${ERROR_PREFIX} ${chalk.white("Not authenticated.")}`);
    console.error(
      chalk.gray("  ↳ Run 'revx configure' to set up credentials.\n"),
    );
    process.exit(1);
  }

  if (err instanceof AuthenticationError) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}`);
    console.error(
      chalk.gray("  ↳ Check your API key and private key configuration."),
    );
    console.error(
      chalk.gray("    Run 'revx configure' to update your credentials.\n"),
    );
    process.exit(1);
  }

  if (err instanceof ForbiddenError) {
    const SUGGESTIONS = [
      " ↳ Go to Revolut X → Profile → Add public key",
      "   Check your API scopes to ensure you have the correct permissions",
      "   Ensure the 'Allow usage via Revolut X MCP and CLI' checkbox is ticked on your API key",
    ];

    console.error(`\n${ERROR_PREFIX} ${chalk.white("Access Forbidden")}`);

    console.error(chalk.cyan("How to fix this:"));
    SUGGESTIONS.forEach((step) => {
      console.error(chalk.gray(`  ${chalk.blue("→")} ${step}`));
    });
    console.error("");
    process.exit(1);
  }

  if (err instanceof RateLimitError) {
    console.error(`${ERROR_PREFIX} ${chalk.white("Rate limit exceeded.")}`);
    console.error(chalk.gray("  ↳ Please wait and try again.\n"));
    process.exit(1);
  }

  if (err instanceof BadRequestError) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}\n`);
    process.exit(1);
  }

  if (err instanceof NotFoundError) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}\n`);
    process.exit(1);
  }

  if (err instanceof NetworkError) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}`);
    console.error(
      chalk.gray("  ↳ Check your internet connection and try again.\n"),
    );
    process.exit(1);
  }

  if (err instanceof ValidationError) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}`);
    for (const issue of validationIssues(err.errors)) {
      console.error(chalk.gray(`  ↳ ${issue}`));
    }
    console.error("");
    process.exit(1);
  }

  if (err instanceof RevolutXError) {
    const failure = retryFailure(err);
    console.error(
      `${ERROR_PREFIX} ${chalk.white(err.message)}${failure ? "" : "\n"}`,
    );
    if (failure) console.error(chalk.gray(`  ↳ ${failure}\n`));
    process.exit(1);
  }

  if (err instanceof Error) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}\n`);
    process.exit(1);
  }

  console.error(
    `${ERROR_PREFIX} ${chalk.white("An unknown error occurred.")}\n`,
  );
  process.exit(1);
}
