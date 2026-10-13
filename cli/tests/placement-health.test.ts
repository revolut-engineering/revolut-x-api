import { describe, expect, it } from "vitest";
import { PlacementHealth } from "../src/engine/placement-health.js";

describe("PlacementHealth", () => {
  it("counts rejections of one slot across separate calls", () => {
    // given
    const health = new PlacementHealth();

    // when
    health.rejected("sell:p1", "client-1");
    health.rejected("sell:p1", "client-2");
    const rejections = health.rejected("sell:p1", "client-3");

    // then
    expect(rejections).toBe(3);
  });

  it("counts nothing for a rejection it has already counted", () => {
    // given
    const health = new PlacementHealth();
    health.rejected("sell:p1", "client-1");

    // when
    const repeat = health.rejected("sell:p1", "client-1");

    // then
    expect(repeat).toBeNull();
    expect(health.rejected("sell:p1", "client-2")).toBe(2);
  });

  it("keeps separate counts for separate slots", () => {
    // given
    const health = new PlacementHealth();
    health.rejected("sell:p1", "client-1");
    health.rejected("sell:p1", "client-2");

    // when
    const rejections = health.rejected("buy:0", "client-3");

    // then
    expect(rejections).toBe(1);
  });

  it("keeps counting when a re-send is only accepted", () => {
    // given
    const health = new PlacementHealth();
    health.rejected("buy:0", "client-1");
    health.rejected("buy:0", "client-2");

    // when
    health.sent("buy:0", "order-3");
    const rejections = health.rejected("buy:0", "client-3");

    // then
    expect(rejections).toBe(3);
  });

  it("starts the count again once a re-send is seen on the book or filled", () => {
    // given
    const health = new PlacementHealth();
    health.rejected("buy:0", "client-1");
    health.rejected("buy:0", "client-2");
    health.sent("buy:0", "order-3");

    // when
    health.confirmed("buy:0", "order-3");
    const rejections = health.rejected("buy:0", "client-4");

    // then
    expect(rejections).toBe(1);
  });

  it("ignores an order of the slot that was sent before the rejections", () => {
    // given
    const health = new PlacementHealth();
    health.sent("buy:0", "older-order");
    health.rejected("buy:0", "client-1");
    health.rejected("buy:0", "client-2");

    // when
    health.confirmed("buy:0", "older-order");
    const rejections = health.rejected("buy:0", "client-3");

    // then
    expect(rejections).toBe(3);
  });

  it("remembers a counted rejection after the count starts again", () => {
    // given
    const health = new PlacementHealth();
    health.rejected("buy:0", "client-1");
    health.rejected("buy:0", "client-2");
    health.sent("buy:0", "order-3");
    health.confirmed("buy:0", "order-3");

    // when
    const repeat = health.rejected("buy:0", "client-1");

    // then
    expect(repeat).toBeNull();
    expect(health.rejected("buy:0", "client-4")).toBe(1);
  });

  it("re-arms the alert, but keeps the count, when an order of the slot is found on the exchange", () => {
    // given
    const health = new PlacementHealth();
    health.rejected("sell:p1", "client-1");
    health.rejected("sell:p1", "client-2");
    health.failed("sell:p1", "Insufficient balance", "the sell");
    health.takeAlerts();

    // when
    health.adopted("sell:p1");
    health.failed("sell:p1", "fetch failed", "the sell");

    // then
    expect(health.takeAlerts()).toEqual([
      { order: "the sell", reason: "fetch failed" },
    ]);
    expect(health.rejected("sell:p1", "client-3")).toBe(3);
  });

  it("alerts once per failure streak, until an order of the slot is accepted", () => {
    // given
    const health = new PlacementHealth();
    health.failed("buy:0", "Insufficient balance", "the buy");
    const first = health.takeAlerts();
    health.failed("buy:0", "Insufficient balance", "the buy");
    const repeat = health.takeAlerts();
    health.sent("buy:0", "order-1");

    // when
    health.failed("buy:0", "fetch failed", "the buy");

    // then
    expect(first).toEqual([
      { order: "the buy", reason: "Insufficient balance" },
    ]);
    expect(repeat).toEqual([]);
    expect(health.takeAlerts()).toEqual([
      { order: "the buy", reason: "fetch failed" },
    ]);
  });

  it("alerts nothing for a failure that was fixed before the alerts are taken", () => {
    // given
    const health = new PlacementHealth();
    health.failed("sell:p1", "fetch failed", "the sell");

    // when
    health.sent("sell:p1", "order-1");

    // then
    expect(health.takeAlerts()).toEqual([]);
  });

  it("keeps the latest failure reason until an order of the slot goes out", () => {
    // given
    const health = new PlacementHealth();
    health.failed("buy:0", "fetch failed", "the buy");
    health.failed("buy:0", "Insufficient balance", "the buy");
    const latest = health.failureReason("buy:0");

    // when
    health.sent("buy:0", "order-1");

    // then
    expect(latest).toBe("Insufficient balance");
    expect(health.failureReason("buy:0")).toBeNull();
  });

  it("clears the failure when an order of the slot is found on the exchange", () => {
    // given
    const health = new PlacementHealth();
    health.failed("buy:0", "fetch failed", "the buy");

    // when
    health.adopted("buy:0");

    // then
    expect(health.failureReason("buy:0")).toBeNull();
    expect(health.takeAlerts()).toEqual([]);
  });

  it("forgets every slot on reset", () => {
    // given
    const health = new PlacementHealth();
    health.rejected("buy:0", "client-1");
    health.rejected("buy:0", "client-2");
    health.failed("buy:0", "Insufficient balance", "the buy");

    // when
    health.reset();

    // then
    expect(health.rejected("buy:0", "client-3")).toBe(1);
    expect(health.failureReason("buy:0")).toBeNull();
    expect(health.takeAlerts()).toEqual([]);
  });
});
