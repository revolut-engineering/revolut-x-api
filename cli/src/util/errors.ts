import {
  RevolutXError,
  AuthenticationError,
  AuthNotConfiguredError,
  RateLimitError,
  OrderError,
  NotFoundError,
  NetworkError,
} from "revolutx-api";

export function handleError(err: unknown): never {
  if (err instanceof AuthNotConfiguredError) {
    console.error(
      "Error: Not authenticated. Run 'revx configure' to set up credentials.",
    );
    process.exit(1);
  }

  if (err instanceof AuthenticationError) {
    console.error(`Error: ${err.message}`);
    console.error("Check your API key and private key configuration.");
    process.exit(1);
  }

  if (err instanceof RateLimitError) {
    console.error("Error: Rate limit exceeded. Please wait and try again.");
    process.exit(1);
  }

  if (err instanceof OrderError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (err instanceof NotFoundError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (err instanceof NetworkError) {
    console.error(`Error: ${err.message}`);
    console.error("Check your internet connection and try again.");
    process.exit(1);
  }

  if (err instanceof RevolutXError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.error("Error: An unknown error occurred.");
  process.exit(1);
}
