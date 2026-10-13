import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ForbiddenError,
  NetworkError,
  RateLimitError,
  ServerError,
} from "@revolut/revolut-x-api";
import {
  OUTAGE_ALERT_MS,
  OutageWatch,
  exchangeFault,
} from "../src/engine/outage-watch.js";

describe("OutageWatch", () => {
  const MINUTE = 60_000;

  it("says to alert once after five minutes without data", () => {
    // given
    const watch = new OutageWatch();

    // when
    const atStart = watch.failed("unreachable", 0);
    const justBefore = watch.failed("unreachable", OUTAGE_ALERT_MS - 1);
    const atFive = watch.failed("unreachable", OUTAGE_ALERT_MS);
    const later = watch.failed("unreachable", OUTAGE_ALERT_MS * 2);

    // then
    expect([atStart, justBefore, atFive, later]).toEqual([
      null,
      null,
      { fault: "unreachable", minutes: 5, retry: false },
      null,
    ]);
  });

  it("says to alert a refused key at once and only once", () => {
    // given
    const watch = new OutageWatch();

    // when
    const first = watch.failed("refused", 0);
    const again = watch.failed("refused", MINUTE);
    const outage = watch.failed("unreachable", OUTAGE_ALERT_MS * 2);

    // then
    expect(first).toEqual({ fault: "refused", minutes: 0, retry: false });
    expect(again).toBeNull();
    expect(outage).toBeNull();
  });

  it("still alerts a refused key after an outage was alerted", () => {
    // given
    const watch = new OutageWatch();
    watch.failed("unreachable", 0);
    watch.failed("unreachable", OUTAGE_ALERT_MS);

    // when
    const refused = watch.failed("refused", OUTAGE_ALERT_MS + MINUTE);

    // then
    expect(refused).toEqual({ fault: "refused", minutes: 6, retry: false });
  });

  it("says what recovered and after how long, only after an alert", () => {
    // given
    const quiet = new OutageWatch();
    quiet.failed("unreachable", 0);
    const alerted = new OutageWatch();
    alerted.failed("unreachable", 0);
    alerted.failed("unreachable", OUTAGE_ALERT_MS);
    const refused = new OutageWatch();
    refused.failed("refused", 0);

    // then
    expect(quiet.recovered(OUTAGE_ALERT_MS)).toBeNull();
    expect(alerted.recovered(7 * MINUTE)).toEqual({
      fault: "unreachable",
      minutes: 7,
      retry: false,
    });
    expect(alerted.recovered(8 * MINUTE)).toBeNull();
    expect(refused.recovered(2 * MINUTE)).toEqual({
      fault: "refused",
      minutes: 2,
      retry: false,
    });
  });

  it("starts counting again after a recovery", () => {
    // given
    const watch = new OutageWatch();
    watch.failed("unreachable", 0);
    watch.recovered(1);

    // then
    expect(watch.failed("unreachable", OUTAGE_ALERT_MS)).toBeNull();
    expect(watch.failed("unreachable", OUTAGE_ALERT_MS * 2)).toEqual({
      fault: "unreachable",
      minutes: 5,
      retry: false,
    });
  });

  it("sends a lost alert again a minute later, marked as a retry", () => {
    // given
    const watch = new OutageWatch();
    const lost = watch.failed("refused", 0)!;

    // when
    watch.undelivered(lost, 0);
    const tooSoon = watch.failed("refused", MINUTE - 1);
    const retried = watch.failed("refused", MINUTE);

    // then
    expect(tooSoon).toBeNull();
    expect(retried).toEqual({ fault: "refused", minutes: 1, retry: true });
    expect(watch.failed("refused", 2 * MINUTE)).toBeNull();
  });

  it("keeps a delivered outage alert when a later key alert is lost", () => {
    // given
    const watch = new OutageWatch();
    watch.failed("unreachable", 0);
    watch.failed("unreachable", OUTAGE_ALERT_MS);
    const lost = watch.failed("refused", OUTAGE_ALERT_MS + MINUTE)!;

    // when
    watch.undelivered(lost, OUTAGE_ALERT_MS + MINUTE);

    // then
    expect(watch.failed("refused", OUTAGE_ALERT_MS + 2 * MINUTE)).toEqual({
      fault: "refused",
      minutes: 7,
      retry: true,
    });
    expect(watch.recovered(OUTAGE_ALERT_MS + 3 * MINUTE)).toEqual({
      fault: "refused",
      minutes: 8,
      retry: false,
    });
  });

  it("reports no recovery when no alert of the outage was delivered", () => {
    // given
    const watch = new OutageWatch();
    watch.failed("unreachable", 0);
    const noData = watch.failed("unreachable", OUTAGE_ALERT_MS)!;
    const refused = watch.failed("refused", OUTAGE_ALERT_MS + MINUTE)!;

    // when
    watch.undelivered(noData, OUTAGE_ALERT_MS + MINUTE);
    watch.undelivered(refused, OUTAGE_ALERT_MS + MINUTE);

    // then
    expect(watch.recovered(OUTAGE_ALERT_MS + 2 * MINUTE)).toBeNull();
  });

  it("ignores a lost alert from an earlier refusal", () => {
    // given
    const watch = new OutageWatch();
    const lost = watch.failed("refused", 0)!;
    watch.recovered(MINUTE);
    watch.failed("refused", 2 * MINUTE);

    // when
    watch.undelivered(lost, 2 * MINUTE);

    // then
    expect(watch.failed("refused", 4 * MINUTE)).toBeNull();
  });

  it("sends a lost recovery message again a minute later", () => {
    // given
    const watch = new OutageWatch();
    watch.failed("refused", 0);
    const back = watch.recovered(2 * MINUTE)!;

    // when
    watch.undelivered(back, 2 * MINUTE);
    const tooSoon = watch.recovered(3 * MINUTE - 1);
    const retried = watch.recovered(3 * MINUTE);

    // then
    expect(tooSoon).toBeNull();
    expect(retried).toEqual({ fault: "refused", minutes: 2, retry: true });
    expect(watch.recovered(4 * MINUTE)).toBeNull();
  });

  it("drops a lost recovery message once the exchange fails again", () => {
    // given
    const watch = new OutageWatch();
    watch.failed("refused", 0);
    watch.undelivered(watch.recovered(MINUTE)!, MINUTE);

    // when
    watch.failed("unreachable", 2 * MINUTE);

    // then
    expect(watch.recovered(4 * MINUTE)).toBeNull();
  });

  it("never counts negative minutes when the clock moves back", () => {
    // given
    const watch = new OutageWatch();
    watch.failed("unreachable", 10 * MINUTE);

    // then
    expect(watch.failed("refused", 0)).toEqual({
      fault: "refused",
      minutes: 0,
      retry: false,
    });
  });
});

describe("exchangeFault", () => {
  it.each([
    ["a 401", new AuthenticationError("Unable to resolve API key"), "refused"],
    ["a 403", new ForbiddenError("Forbidden"), "refused"],
    [
      "a wrapped 401",
      new Error("Failed to fetch active orders", {
        cause: new AuthenticationError("Unauthorized"),
      }),
      "refused",
    ],
    ["a network error", new NetworkError("No reply"), "unreachable"],
    ["a rate limit", new RateLimitError("Rate limit exceeded"), "unreachable"],
    ["a server error", new ServerError("Bad gateway", 502), "unreachable"],
    ["a plain error", new Error("No price data for BTC-USD"), "unreachable"],
    ["no error at all", undefined, "unreachable"],
  ])("calls %s %s", (_, err, fault) => {
    expect(exchangeFault(err)).toBe(fault);
  });
});
