import { describe, expect, it } from "vitest";
import {
  BadRequestError,
  NetworkError,
  ServerError,
} from "@revolut/revolut-x-api";
import {
  placementDoubt,
  placementOutcome,
  uncertainPlacement,
  type PlacementContext,
} from "../src/util/order-outcome.js";

const PLACE: PlacementContext = {
  action: "place",
  orderId: "v-1",
  immediateOrCancel: false,
  postOnly: false,
};

const REPLACE: PlacementContext = {
  action: "replace",
  orderId: "v-2",
  originalOrderId: "v-1",
  immediateOrCancel: false,
  postOnly: false,
};

const IOC_PLACE: PlacementContext = { ...PLACE, immediateOrCancel: true };

describe("placementOutcome", () => {
  it.each([
    ["pending_new", "Order placed."],
    ["new", "Order placed."],
    [
      "partially_filled",
      "Order placed and partly filled. The rest stays open.",
    ],
    ["filled", "Order placed. The exchange reports it filled."],
  ] as const)("reports %s as placed", (state, headline) => {
    // when
    const outcome = placementOutcome(state, PLACE);

    // then
    expect(outcome).toEqual({ kind: "success", headline });
  });

  it("says the rest of a partly filled IOC order was cancelled", () => {
    // when
    const outcome = placementOutcome("partially_filled", IOC_PLACE);

    // then
    expect(outcome.headline).toBe(
      "Order placed and partly filled. The rest was cancelled.",
    );
  });

  it.each(["cancelled", "canceled"])(
    "reports an IOC order that closed at once (%s) as a warning, not a failure",
    (state) => {
      // when
      const outcome = placementOutcome(state, IOC_PLACE);

      // then
      expect(outcome).toEqual({
        kind: "warning",
        headline:
          "Order closed at once. An IOC or market order cancels whatever it can't fill straight away.",
        hint: "See what filled in a few seconds with: revx order fills v-1",
      });
    },
  );

  it.each(["cancelled", "canceled"])(
    "reports a resting order the exchange cancelled at once (%s) as a failure that may have traded",
    (state) => {
      // when
      const outcome = placementOutcome(state, PLACE);

      // then
      expect(outcome).toEqual({
        kind: "error",
        headline:
          "The exchange cancelled the order at once. It may have partly filled, so check before placing it again.",
        hint: "See why and what filled in a few seconds with: revx order get v-1",
      });
    },
  );

  it("reports a rejected order as a failure", () => {
    // when
    const outcome = placementOutcome("rejected", PLACE);

    // then
    expect(outcome).toEqual({
      kind: "error",
      headline: "The exchange rejected the order.",
      hint: "See why in a few seconds with: revx order get v-1",
    });
  });

  it("names the usual cause of a rejected post-only order", () => {
    // when
    const outcome = placementOutcome("rejected", { ...PLACE, postOnly: true });

    // then
    expect(outcome.headline).toBe(
      "The exchange rejected the order. A post-only order is usually rejected because its price would trade at once.",
    );
  });

  it("says neither order is open when a replacement is rejected", () => {
    // when
    const outcome = placementOutcome("rejected", REPLACE);

    // then
    expect(outcome).toEqual({
      kind: "error",
      headline:
        "The exchange rejected the replacement. A replace cancels the original order v-1 first, so neither order is open now.",
      hint: "See why in a few seconds with: revx order get v-2",
    });
  });

  it("says neither order is open when a replacement is cancelled at once", () => {
    // when
    const outcome = placementOutcome("cancelled", REPLACE);

    // then
    expect(outcome).toEqual({
      kind: "error",
      headline:
        "The exchange cancelled the replacement at once. A replace cancels the original order v-1 first, so neither order is open now. It may have partly filled, so check before placing it again.",
      hint: "See why and what filled in a few seconds with: revx order get v-2",
    });
  });

  it("reports an IOC replacement that closed at once as a warning", () => {
    // when
    const outcome = placementOutcome("cancelled", {
      ...REPLACE,
      immediateOrCancel: true,
    });

    // then
    expect(outcome).toEqual({
      kind: "warning",
      headline:
        "Order replaced by an IOC order that closed at once. It cancels whatever it can't fill straight away.",
      hint: "See what filled in a few seconds with: revx order fills v-2",
    });
  });

  it.each([
    ["new", "Order replaced."],
    ["filled", "Order replaced. The exchange reports it filled."],
  ] as const)("reports a %s replacement as replaced", (state, headline) => {
    // when
    const outcome = placementOutcome(state, REPLACE);

    // then
    expect(outcome).toEqual({ kind: "success", headline });
  });

  it("passes on a state it doesn't know without calling it a failure", () => {
    // when
    const outcome = placementOutcome("expired", PLACE);

    // then
    expect(outcome).toEqual({
      kind: "warning",
      headline: "Order sent. The exchange answered with state expired.",
      hint: "Check it in a few seconds with: revx order get v-1",
    });
  });
});

describe("uncertainPlacement", () => {
  const PLACE_CONTEXT = {
    action: "place" as const,
    symbol: "BTC-USD",
    clientOrderId: "c-1",
  };
  const CHECK =
    "Check in a few seconds with: revx order open --symbols BTC-USD --json, or revx order history --symbols BTC-USD --json once it has filled. A market order can take a few minutes to show up.";
  const RETRY =
    "To retry, run the same command with --client-order-id c-1. If the first one went through, the exchange refuses the retry as already placed.";
  const ALREADY_PLACED =
    "An order with the client_order_id 'c-1' has already been placed";

  it("says an order whose reply was lost may have been placed, with the id and a safe retry", () => {
    // when
    const lines = uncertainPlacement(
      new NetworkError("No reply from the exchange: UND_ERR_SOCKET.", {
        mayHaveReachedServer: true,
      }),
      PLACE_CONTEXT,
    );

    // then
    expect(lines).toEqual([
      "No reply from the exchange: UND_ERR_SOCKET. The order may have been placed.",
      "Client order ID: c-1",
      CHECK,
      RETRY,
    ]);
  });

  it("leaves a request that never reached the exchange to the usual error", () => {
    // when
    const lines = uncertainPlacement(
      new NetworkError("Could not reach the exchange: ECONNREFUSED.", {
        mayHaveReachedServer: false,
      }),
      PLACE_CONTEXT,
    );

    // then
    expect(lines).toBeNull();
  });

  it("treats a server error after retries as maybe placed", () => {
    // when
    const lines = uncertainPlacement(
      new ServerError("Internal error", 503),
      PLACE_CONTEXT,
    );

    // then
    expect(lines?.[0]).toBe(
      "The exchange answered with a server error (503). The order may have been placed.",
    );
  });

  it("says why the automatic retry after a server error failed", () => {
    // when
    const lines = uncertainPlacement(
      new ServerError("Internal error", 503, {
        cause: new BadRequestError("Insufficient balance"),
      }),
      PLACE_CONTEXT,
    );

    // then
    expect(lines).toEqual([
      "The exchange answered with a server error (503). The order may have been placed.",
      "The automatic retry then failed: Insufficient balance.",
      "Client order ID: c-1",
      CHECK,
      RETRY,
    ]);
  });

  it("says the order reached the exchange when the resend of its own id is refused as already placed", () => {
    // when
    const lines = uncertainPlacement(
      new BadRequestError(ALREADY_PLACED, {
        cause: new ServerError("Unavailable", 503),
      }),
      PLACE_CONTEXT,
    );

    // then
    expect(lines).toEqual([
      "The order reached the exchange. It first answered with a server error, then refused the automatic retry as already placed.",
      "Client order ID: c-1",
      CHECK,
    ]);
  });

  it("says no second order was placed when the id already exists", () => {
    // when
    const lines = uncertainPlacement(
      new BadRequestError(ALREADY_PLACED),
      PLACE_CONTEXT,
    );

    // then
    expect(lines).toEqual([
      "An order with client order ID c-1 already exists, so no second one was placed.",
      CHECK,
    ]);
  });

  it("says a replacement reached the exchange when the resend of its own id is refused", () => {
    // when
    const lines = uncertainPlacement(
      new BadRequestError(ALREADY_PLACED, {
        cause: new ServerError("Unavailable", 503),
      }),
      { action: "replace", originalOrderId: "v-1", clientOrderId: "c-2" },
    );

    // then
    expect(lines?.[0]).toBe(
      "The replacement reached the exchange. It first answered with a server error, then refused the automatic retry as already placed.",
    );
    expect(lines?.[1]).toBe("Client order ID: c-2");
  });

  it("names a replacement whose id already exists", () => {
    // when
    const lines = uncertainPlacement(new BadRequestError(ALREADY_PLACED), {
      action: "replace",
      originalOrderId: "v-1",
      clientOrderId: "c-2",
    });

    // then
    expect(lines?.[0]).toBe(
      "A replacement with client order ID c-2 already exists, so no second one was placed.",
    );
  });

  it("tells how to see whether a replace happened", () => {
    // when
    const lines = uncertainPlacement(
      new NetworkError("No reply from the exchange: UND_ERR_SOCKET.", {
        mayHaveReachedServer: true,
      }),
      {
        action: "replace",
        originalOrderId: "v-1",
        clientOrderId: "c-2",
      },
    );

    // then
    expect(lines).toEqual([
      "No reply from the exchange: UND_ERR_SOCKET. The replacement may have been placed.",
      "Client order ID: c-2",
      "If revx order get v-1 shows the original still open, the replace didn't happen and can be run again. If it is cancelled, look for client order ID c-2 in revx order open --json or revx order history --json.",
      "To retry, run the same command with --client-order-id c-2. If the first one went through, the exchange refuses the retry as already placed.",
    ]);
  });
});

describe("placementDoubt", () => {
  it.each([
    [
      "a reply lost after sending",
      new NetworkError("No reply from the exchange: UND_ERR_SOCKET."),
      "its reply was lost: No reply from the exchange: UND_ERR_SOCKET",
    ],
    [
      "a server error",
      new ServerError("Internal error", 503),
      "the exchange answered with a server error (503)",
    ],
    [
      "a request that never left",
      new NetworkError("Could not reach the exchange: ECONNREFUSED.", {
        mayHaveReachedServer: false,
      }),
      null,
    ],
    ["a refusal", new BadRequestError("Insufficient balance"), null],
  ])("explains %s", (_, err, doubt) => {
    expect(placementDoubt(err)).toBe(doubt);
  });
});
