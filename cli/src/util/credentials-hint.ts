import { redactHome, type CredentialsIssue } from "@revolut/revolut-x-api";
import { unreadableFileAdvice } from "./file-advice.js";

export function credentialsHint(issue: CredentialsIssue): string {
  const path = redactHome(issue.path);
  switch (issue.fault) {
    case "unreadable":
      return unreadableFileAdvice(issue.path, issue.code);
    case "not_a_file":
      return `Move the folder ${path} out of the way, then run 'revx configure'.`;
    case "missing":
      return `If you have a copy of the key, put it back at ${path}. Otherwise run 'revx configure' to make a new key pair, register its public key with Revolut X and create a new API key for it.`;
    case "malformed":
      return issue.file === "config"
        ? "Fix the file, or save the API key again with: revx configure set --api-key <key>"
        : "Run 'revx configure'. It offers to move this key aside and make a new key pair.";
  }
}
