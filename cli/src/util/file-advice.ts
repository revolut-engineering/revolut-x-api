import { dirname } from "node:path";
import { redactHome } from "@revolut/revolut-x-api";

export function unreadableFileAdvice(path: string, code?: string): string {
  return code === "EACCES" || code === "EPERM"
    ? `Make sure the file and its folder belong to you and you can read them, for example: chmod 700 ${redactHome(dirname(path))} and chmod 600 ${redactHome(path)}.`
    : `Check ${redactHome(path)} and fix what stops it from being read, such as a broken link.`;
}
