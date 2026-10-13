import {
  NetworkError,
  ServerError,
  isDuplicateClientOrderIdError,
} from "@revolut/revolut-x-api";

export type PlacementContext =
  | {
      action: "place";
      orderId: string;
      immediateOrCancel: boolean;
      postOnly: boolean;
    }
  | {
      action: "replace";
      orderId: string;
      originalOrderId: string;
      immediateOrCancel: boolean;
      postOnly: boolean;
    };

export interface PlacementOutcome {
  kind: "success" | "warning" | "error";
  headline: string;
  hint?: string;
}

const POST_ONLY_CAUSE =
  " A post-only order is usually rejected because its price would trade at once.";

export function placementOutcome(
  state: string,
  context: PlacementContext,
): PlacementOutcome {
  const placed = context.action === "place" ? "placed" : "replaced";
  const subject = context.action === "place" ? "order" : "replacement";
  const inAFewSeconds = (what: string, command: "get" | "fills") =>
    `${what} in a few seconds with: revx order ${command} ${context.orderId}`;
  const originalGone =
    context.action === "replace"
      ? ` A replace cancels the original order ${context.originalOrderId} first, so neither order is open now.`
      : "";
  switch (state) {
    case "pending_new":
    case "new":
      return { kind: "success", headline: `Order ${placed}.` };
    case "partially_filled":
      return {
        kind: "success",
        headline: context.immediateOrCancel
          ? `Order ${placed} and partly filled. The rest was cancelled.`
          : `Order ${placed} and partly filled. The rest stays open.`,
      };
    case "filled":
      return {
        kind: "success",
        headline: `Order ${placed}. The exchange reports it filled.`,
      };
    case "cancelled":
    case "canceled":
      if (context.immediateOrCancel) {
        return {
          kind: "warning",
          headline:
            context.action === "place"
              ? "Order closed at once. An IOC or market order cancels whatever it can't fill straight away."
              : "Order replaced by an IOC order that closed at once. It cancels whatever it can't fill straight away.",
          hint: inAFewSeconds("See what filled", "fills"),
        };
      }
      return {
        kind: "error",
        headline: `The exchange cancelled the ${subject} at once.${originalGone} It may have partly filled, so check before placing it again.`,
        hint: inAFewSeconds("See why and what filled", "get"),
      };
    case "rejected":
      return {
        kind: "error",
        headline: `The exchange rejected the ${subject}.${originalGone}${context.postOnly ? POST_ONLY_CAUSE : ""}`,
        hint: inAFewSeconds("See why", "get"),
      };
    default:
      return {
        kind: "warning",
        headline: `Order sent. The exchange answered with state ${state}.`,
        hint: inAFewSeconds("Check it", "get"),
      };
  }
}

export type SendContext =
  | {
      action: "place";
      symbol: string;
      clientOrderId: string;
    }
  | {
      action: "replace";
      originalOrderId: string;
      clientOrderId: string;
    };

export function placementDoubt(err: unknown): string | null {
  if (err instanceof NetworkError && err.mayHaveReachedServer) {
    return `its reply was lost: ${err.message.trim().replace(/\.+$/, "")}`;
  }
  if (err instanceof ServerError) {
    return `the exchange answered with a server error (${err.statusCode})`;
  }
  return null;
}

export function retryFailure(err: unknown): string | null {
  if (!(err instanceof ServerError) || !(err.cause instanceof Error)) {
    return null;
  }
  return `The automatic retry then failed: ${err.cause.message.replace(/\.+$/, "")}.`;
}

export function uncertainPlacement(
  err: unknown,
  context: SendContext,
): string[] | null {
  const subject = context.action === "place" ? "order" : "replacement";
  const id = `Client order ID: ${context.clientOrderId}`;
  const check =
    context.action === "place"
      ? `Check in a few seconds with: revx order open --symbols ${context.symbol} --json, or revx order history --symbols ${context.symbol} --json once it has filled. A market order can take a few minutes to show up.`
      : `If revx order get ${context.originalOrderId} shows the original still open, the replace didn't happen and can be run again. If it is cancelled, look for client order ID ${context.clientOrderId} in revx order open --json or revx order history --json.`;
  const retry = `To retry, run the same command with --client-order-id ${context.clientOrderId}. If the first one went through, the exchange refuses the retry as already placed.`;
  if (err instanceof NetworkError && err.mayHaveReachedServer) {
    return [
      `${err.message} The ${subject} may have been placed.`,
      id,
      check,
      retry,
    ];
  }
  if (err instanceof ServerError) {
    const failure = retryFailure(err);
    return [
      `The exchange answered with a server error (${err.statusCode}). The ${subject} may have been placed.`,
      ...(failure ? [failure] : []),
      id,
      check,
      retry,
    ];
  }
  if (isDuplicateClientOrderIdError(err)) {
    if (err instanceof Error && err.cause instanceof ServerError) {
      return [
        `The ${subject} reached the exchange. It first answered with a server error, then refused the automatic retry as already placed.`,
        id,
        check,
      ];
    }
    return [
      `${context.action === "place" ? "An order" : "A replacement"} with client order ID ${context.clientOrderId} already exists, so no second one was placed.`,
      check,
    ];
  }
  return null;
}
