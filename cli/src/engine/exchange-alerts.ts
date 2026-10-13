import { ForbiddenError, loadConfig } from "@revolut/revolut-x-api";
import { maskSecret } from "../util/mask.js";
import { refusalOf, type OutageAlert } from "./outage-watch.js";

export type KeyUser = "grid" | "monitor";

export interface RefusalContext {
  user: KeyUser;
  keyLabel: string | null;
  meanwhile?: string;
}

export function savedKeyLabel(): string | null {
  try {
    const key = loadConfig().api_key?.trim();
    return key ? maskSecret(key) : null;
  } catch {
    return null;
  }
}

function refusal(err: unknown): { forbidden: boolean; detail: string } {
  const refused = refusalOf(err);
  const forbidden = refused instanceof ForbiddenError;
  const status = forbidden ? "403" : "401";
  const reason = (refused?.message ?? "").trim().replace(/\.+$/, "");
  const detail =
    reason && !/^HTTP \d+$/i.test(reason) ? `${status} ${reason}` : status;
  return { forbidden, detail };
}

export function refusedKeyMessage(
  subject: string,
  err: unknown,
  context: RefusalContext,
): string {
  const { forbidden, detail } = refusal(err);
  const key = context.keyLabel ? ` ${context.keyLabel}` : "";
  const advice = forbidden
    ? `Check that the public key is added in Revolut X, that the key has the permissions it needs and that 'Allow usage via Revolut X MCP and CLI' is ticked. The ${context.user} goes on by itself once the key works.`
    : `Check the API key and the private key with revx configure, then start the ${context.user} again.`;
  return [
    `${subject}: Revolut X refused the API key${key} with ${detail}.`,
    advice,
    context.meanwhile,
  ]
    .filter(Boolean)
    .join(" ");
}

export function refusedKeyNotice(err: unknown, user: KeyUser): string {
  const { forbidden, detail } = refusal(err);
  return forbidden
    ? `Revolut X refused the API key with ${detail}. Check its permissions in Revolut X.`
    : `Revolut X refused the API key with ${detail}. Check it with revx configure, then start the ${user} again.`;
}

export function noDataMessage(
  subject: string,
  minutes: number,
  lastError: string,
): string {
  return `${subject}: no data from Revolut X for ${minutes} minutes. Still trying.\nLast error: ${lastError}`;
}

export function recoveryMessage(subject: string, alert: OutageAlert): string {
  if (alert.fault === "refused") {
    return `${subject}: Revolut X accepts the API key again.`;
  }
  const unit = alert.minutes === 1 ? "minute" : "minutes";
  return `${subject}: data from Revolut X is back after ${alert.minutes} ${unit}.`;
}
