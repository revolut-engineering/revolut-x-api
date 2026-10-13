import { RevolutXClient } from "@revolut/revolut-x-api";
import { handleError } from "./errors.js";

let cachedClient: RevolutXClient | undefined;

export function getClient(opts?: { requireAuth?: boolean }): RevolutXClient {
  try {
    const client = (cachedClient ??= new RevolutXClient({
      generatedBy: "CLI",
      enforceKeyPermissions: true,
    }));
    if (opts?.requireAuth) client.assertAuthenticated();
    return client;
  } catch (err) {
    handleError(err);
  }
}
