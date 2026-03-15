import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import {
  createTestClient,
  BASE_URL,
  mockCurrency,
  mockCurrencyPair,
} from "../helpers/test-utils.js";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("Configuration", () => {
  describe("getCurrencies", () => {
    it("returns currency map", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/configuration/currencies")
        .reply(200, {
          BTC: mockCurrency,
          ETH: {
            symbol: "ETH",
            name: "Ethereum",
            scale: 8,
            asset_type: "crypto",
            status: "active",
          },
        });

      const result = await client.getCurrencies();

      expect(result.BTC).toMatchObject({
        symbol: "BTC",
        name: "Bitcoin",
        scale: 8,
      });
      expect(result.ETH.name).toBe("Ethereum");
    });

    it("returns empty map when no currencies", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/configuration/currencies").reply(200, {});

      const result = await client.getCurrencies();

      expect(result).toEqual({});
    });

    it("includes fiat and crypto currencies", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/configuration/currencies")
        .reply(200, {
          BTC: { ...mockCurrency, asset_type: "crypto" },
          USD: {
            symbol: "USD",
            name: "US Dollar",
            scale: 2,
            asset_type: "fiat",
            status: "active",
          },
        });

      const result = await client.getCurrencies();

      expect(result.BTC.asset_type).toBe("crypto");
      expect(result.USD.asset_type).toBe("fiat");
    });
  });

  describe("getCurrencyPairs", () => {
    it("returns currency pair map", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/configuration/pairs")
        .reply(200, {
          "BTC/USD": mockCurrencyPair,
        });

      const result = await client.getCurrencyPairs();

      expect(result["BTC/USD"]).toMatchObject({
        base: "BTC",
        quote: "USD",
        status: "active",
      });
    });

    it("returns empty map when no pairs", async () => {
      const client = createTestClient();
      nock(BASE_URL).get("/api/1.0/configuration/pairs").reply(200, {});

      const result = await client.getCurrencyPairs();

      expect(result).toEqual({});
    });

    it("includes min/max order sizes", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/configuration/pairs")
        .reply(200, {
          "BTC/USD": mockCurrencyPair,
        });

      const result = await client.getCurrencyPairs();

      expect(result["BTC/USD"].min_order_size).toBe("0.0000001");
      expect(result["BTC/USD"].max_order_size).toBe("1000");
      expect(result["BTC/USD"].min_order_size_quote).toBe("0.01");
    });

    it("includes step sizes for precision", async () => {
      const client = createTestClient();
      nock(BASE_URL)
        .get("/api/1.0/configuration/pairs")
        .reply(200, {
          "BTC/USD": mockCurrencyPair,
        });

      const result = await client.getCurrencyPairs();

      expect(result["BTC/USD"].base_step).toBe("0.0000001");
      expect(result["BTC/USD"].quote_step).toBe("0.01");
    });
  });
});
