import {
  RevolutXError,
  AuthenticationError,
  AuthNotConfiguredError,
  RateLimitError,
  BadRequestError,
  NotFoundError,
  NetworkError,
  ForbiddenError,
} from "api-k9x2a";
import chalk from "chalk";

const ERROR_PREFIX = chalk.red.bold("✖ Error:");

export function handleError(err: unknown): never {
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

  if (err instanceof RevolutXError) {
    console.error(`${ERROR_PREFIX} ${chalk.white(err.message)}\n`);
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
