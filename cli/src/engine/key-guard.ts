import { InsecureKeyPermissionsError } from "api-k9x2a";

export function rethrowIfInsecureKey(err: unknown): void {
  if (err instanceof InsecureKeyPermissionsError) throw err;
}
