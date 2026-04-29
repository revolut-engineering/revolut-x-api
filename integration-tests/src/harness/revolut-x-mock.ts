import { vi, type Mock } from "vitest";

export interface RevolutXMockState {
  getBalances: Mock;
  getCurrencies: Mock;
  getCurrencyPairs: Mock;
  getTickers: Mock;
  getCandles: Mock;
  getOrderBook: Mock;
  getActiveOrders: Mock;
  getHistoricalOrders: Mock;
  getOrder: Mock;
  getOrderFills: Mock;
  getAllTrades: Mock;
  getPrivateTrades: Mock;
}

function makeClientStubs(): RevolutXMockState {
  return {
    getBalances: vi.fn(),
    getCurrencies: vi.fn(),
    getCurrencyPairs: vi.fn(),
    getTickers: vi.fn(),
    getCandles: vi.fn(),
    getOrderBook: vi.fn(),
    getActiveOrders: vi.fn(),
    getHistoricalOrders: vi.fn(),
    getOrder: vi.fn(),
    getOrderFills: vi.fn(),
    getAllTrades: vi.fn(),
    getPrivateTrades: vi.fn(),
  };
}

export const revolutXMockState: RevolutXMockState = makeClientStubs();

export function resetRevolutXMockState(): void {
  revolutXMockState.getBalances.mockReset();
  revolutXMockState.getCurrencies.mockReset();
  revolutXMockState.getCurrencyPairs.mockReset();
  revolutXMockState.getTickers.mockReset();
  revolutXMockState.getCandles.mockReset();
  revolutXMockState.getOrderBook.mockReset();
  revolutXMockState.getActiveOrders.mockReset();
  revolutXMockState.getHistoricalOrders.mockReset();
  revolutXMockState.getOrder.mockReset();
  revolutXMockState.getOrderFills.mockReset();
  revolutXMockState.getAllTrades.mockReset();
  revolutXMockState.getPrivateTrades.mockReset();
}

export async function buildRevolutXMockModule(): Promise<
  Record<string, unknown>
> {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@revolut/revolut-x-api",
  );

  return {
    ...actual,
    RevolutXClient: vi.fn(() => revolutXMockState),
    isConfigured: vi.fn(() => true),
    loadCredentials: vi.fn(() => ({
      apiKey: "test-key",
      privateKey: {} as object,
      privateKeyPath: "/tmp/test-private.pem",
    })),
    ensureConfigDir: vi.fn(),
    getPrivateKeyFile: vi.fn(() => "/tmp/test-private.pem"),
    getPublicKeyFile: vi.fn(() => "/tmp/test-public.pem"),
    getPublicKeyPem: vi.fn(
      () => "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n",
    ),
    generateKeypair: vi.fn(
      () => "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n",
    ),
    loadPrivateKey: vi.fn(() => ({ asymmetricKeyType: "ed25519" })),
    loadConfig: vi.fn(() => ({
      api_key: "test-key",
      private_key_path: "/tmp/test-private.pem",
    })),
    saveConfig: vi.fn(),
  };
}
