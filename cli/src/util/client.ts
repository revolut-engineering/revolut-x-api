import { RevolutXClient } from "@revolut/revolut-x-api";

let cachedClient: RevolutXClient | undefined;

export function getClient(opts?: { requireAuth?: boolean }): RevolutXClient {
  if (cachedClient) return cachedClient;

  cachedClient = new RevolutXClient({
    isAgent: true,
    enforceKeyPermissions: true,
  });

  if (opts?.requireAuth && !cachedClient.isAuthenticated) {
    console.error("Error: Not authenticated. Run 'revx configure' first.");
    process.exit(1);
  }

  return cachedClient;
}
