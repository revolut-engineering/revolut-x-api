import { InsecureKeyPermissionsError } from "@revolut/revolut-x-api";

export function rethrowIfInsecureKey(err: unknown): void {
  if (err instanceof InsecureKeyPermissionsError) throw err;
}
