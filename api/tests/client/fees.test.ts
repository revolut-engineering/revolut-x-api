import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { MAKER_FEE_RATE, TAKER_FEE_RATE } from "../../src/index.js";
import { createTestClient, BASE_URL } from "../helpers/test-utils.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Fees", () => {
  it("exposes the venue fee rates on the client", () => {
    const client = createTestClient();

    expect(client.getMakerFee()).toBe(MAKER_FEE_RATE);
    expect(client.getTakerFee()).toBe(TAKER_FEE_RATE);
  });

  it("reads fees without credentials", () => {
    const client = createTestClient({ authenticated: false });

    expect(client.isAuthenticated).toBe(false);
    expect(client.getMakerFee()).toBe("0");
    expect(client.getTakerFee()).toBe("0.0009");
  });

  it("returns rates that parse exactly", () => {
    expect(Number(MAKER_FEE_RATE)).toBe(0);
    expect(Number(TAKER_FEE_RATE) * 10_000).toBeCloseTo(9, 10);
  });
});

describe("getFeeTiers", () => {
  const mockFeeTiers = {
    data: [
      {
        type: "spot",
        current_tier: 1,
        currency: "USD",
        tiers: [
          {
            tier: 0,
            volume_from: "0",
            volume_to: "10000000",
            maker_fee: "0",
            taker_fee: "0.0009",
          },
          {
            tier: 1,
            volume_from: "10000000",
            volume_to: "50000000",
            maker_fee: "0",
            taker_fee: "0.0004",
          },
          {
            tier: 2,
            volume_from: "50000000",
            maker_fee: "0",
            taker_fee: "0.0002",
          },
        ],
      },
      {
        type: "futures",
        current_tier: null,
        currency: "USD",
        tiers: [
          {
            tier: 0,
            volume_from: "0",
            volume_to: "10000000",
            maker_fee: "0",
            taker_fee: "0.0009",
          },
        ],
      },
    ],
    metadata: { timestamp: 1700000000000 },
  };

  it("returns the spot and futures fee ladders", async () => {
    const client = createTestClient();
    nock(BASE_URL)
      .get("/api/1.0/configuration/fees/tiers")
      .reply(200, mockFeeTiers);

    const result = await client.getFeeTiers();

    expect(result.data).toHaveLength(2);
    expect(result.data[0].type).toBe("spot");
    expect(result.data[0].current_tier).toBe(1);
    expect(result.data[0].tiers).toHaveLength(3);
    expect(result.data[1].type).toBe("futures");
    expect(result.data[1].current_tier).toBeNull();
    expect(result.metadata.timestamp).toBe(1700000000000);
  });

  it("keeps decimal strings and optional volume_to as returned", async () => {
    const client = createTestClient();
    nock(BASE_URL)
      .get("/api/1.0/configuration/fees/tiers")
      .reply(200, mockFeeTiers);

    const result = await client.getFeeTiers();

    const firstTier = result.data[0].tiers[0];
    expect(firstTier.volume_from).toBe("0");
    expect(firstTier.volume_to).toBe("10000000");
    expect(firstTier.maker_fee).toBe("0");
    expect(firstTier.taker_fee).toBe("0.0009");

    const lastTier = result.data[0].tiers[2];
    expect(lastTier.volume_to == null).toBe(true);
    expect(lastTier.volume_from).toBe("50000000");
    expect(lastTier.taker_fee).toBe("0.0002");
  });

  it("returns an empty ladder when no tiers are available", async () => {
    const client = createTestClient();
    nock(BASE_URL)
      .get("/api/1.0/configuration/fees/tiers")
      .reply(200, { data: [], metadata: { timestamp: 1700000000000 } });

    const result = await client.getFeeTiers();

    expect(result.data).toEqual([]);
  });
});
