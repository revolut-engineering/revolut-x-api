import { NotFoundError } from "@revolut/revolut-x-api";
import type { OrderDetails } from "@revolut/revolut-x-api";
import { rethrowIfInsecureKey } from "./key-guard.js";

export interface OrderGateway {
  cancel(orderId: string): Promise<unknown>;
  getOrder(orderId: string): Promise<OrderDetails>;
  isActive(orderId: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type CancelOutcome =
  | { closed: true; order: OrderDetails | null }
  | { closed: false };

export const FILLED_STATUSES = new Set(["filled"]);
export const DEAD_STATUSES = new Set(["cancelled", "rejected", "replaced"]);
const CLOSED_STATUSES = new Set([...FILLED_STATUSES, ...DEAD_STATUSES]);
const CANCEL_TIMEOUT_MS = 5_000;
const CANCEL_POLL_MS = 100;
const TERMINAL_TIMEOUT_MS = 30_000;
const TERMINAL_POLL_MS = 500;

export type OutsideChange = "cancelled" | "replaced";

export function outsideChange(
  order: Pick<OrderDetails, "status" | "reject_reason">,
): OutsideChange | null {
  if (order.status === "rejected") return null;
  if (order.status === "replaced" || order.reject_reason === "replaced") {
    return "replaced";
  }
  return order.status === "cancelled" ? "cancelled" : null;
}

async function isFinal(
  gateway: OrderGateway,
  order: OrderDetails,
): Promise<boolean> {
  if (CLOSED_STATUSES.has(order.status)) return true;
  if (order.status !== "partially_filled") return false;
  return !(await gateway.isActive(order.id));
}

export async function awaitTerminalOrNull(
  gateway: OrderGateway,
  orderId: string,
  timeoutMs: number,
): Promise<OrderDetails | null> {
  const deadline = gateway.now() + timeoutMs;
  while (gateway.now() < deadline) {
    try {
      const order = await gateway.getOrder(orderId);
      if (await isFinal(gateway, order)) return order;
    } catch (err) {
      rethrowIfInsecureKey(err);
    }
    await gateway.sleep(TERMINAL_POLL_MS);
  }
  return null;
}

export async function awaitTerminal(
  gateway: OrderGateway,
  orderId: string,
  timeoutMs = TERMINAL_TIMEOUT_MS,
): Promise<OrderDetails> {
  const order = await awaitTerminalOrNull(gateway, orderId, timeoutMs);
  if (order) return order;
  throw new Error(
    `Order ${orderId} did not reach a final state within ${timeoutMs / 1000}s`,
  );
}

async function cancelReachedOrder(
  gateway: OrderGateway,
  orderId: string,
): Promise<boolean> {
  try {
    await gateway.cancel(orderId);
    return true;
  } catch (err) {
    rethrowIfInsecureKey(err);
    return false;
  }
}

export async function cancelUntilClosed(
  gateway: OrderGateway,
  orderId: string,
): Promise<CancelOutcome> {
  let cancelMissedOrder = !(await cancelReachedOrder(gateway, orderId));
  const deadline = gateway.now() + CANCEL_TIMEOUT_MS;
  let onlyNotFound = true;
  while (gateway.now() < deadline) {
    try {
      const order = await gateway.getOrder(orderId);
      onlyNotFound = false;
      if (await isFinal(gateway, order)) return { closed: true, order };
      if (cancelMissedOrder) {
        cancelMissedOrder = false;
        await cancelReachedOrder(gateway, orderId);
      }
    } catch (err) {
      rethrowIfInsecureKey(err);
      if (!(err instanceof NotFoundError)) onlyNotFound = false;
    }
    await gateway.sleep(CANCEL_POLL_MS);
  }
  return onlyNotFound ? { closed: true, order: null } : { closed: false };
}
