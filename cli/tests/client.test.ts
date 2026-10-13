import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRevolutXClient = vi.fn();

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    RevolutXClient: mockRevolutXClient,
  };
});

// Reset module cache between tests so cachedClient is cleared
beforeEach(async () => {
  vi.resetModules();
  mockRevolutXClient.mockClear();
});

describe("getClient", () => {
  it("creates client with generatedBy and enforceKeyPermissions", async () => {
    const { getClient } = await import("../src/util/client.js");
    getClient();
    expect(mockRevolutXClient).toHaveBeenCalledWith({
      generatedBy: "CLI",
      enforceKeyPermissions: true,
    });
  });

  it("returns the same instance on subsequent calls", async () => {
    const { getClient } = await import("../src/util/client.js");
    const first = getClient();
    const second = getClient();
    expect(first).toBe(second);
    expect(mockRevolutXClient).toHaveBeenCalledTimes(1);
  });
});

describe("getClient with credentials it can't use", () => {
  function capture(): string[] {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    return errors;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says what is wrong with them and how to fix it", async () => {
    // given
    const { InvalidCredentialsError } = await import("@revolut/revolut-x-api");
    mockRevolutXClient.mockImplementation(() => ({
      assertAuthenticated: () => {
        throw new InvalidCredentialsError({
          file: "private_key",
          fault: "malformed",
          path: "/cfg/private.pem",
          problem:
            "The private key /cfg/private.pem is not a valid PEM private key.",
        });
      },
    }));
    const errors = capture();
    const { getClient } = await import("../src/util/client.js");

    // when
    const create = () => getClient({ requireAuth: true });

    // then
    expect(create).toThrow("process.exit");
    expect(errors.join("\n")).toContain(
      "The private key /cfg/private.pem is not a valid PEM private key.",
    );
    expect(errors.join("\n")).toContain(
      "Run 'revx configure'. It offers to move this key aside and make a new key pair.",
    );
  });

  it("asks for setup when nothing is configured", async () => {
    // given
    const { AuthNotConfiguredError } = await import("@revolut/revolut-x-api");
    mockRevolutXClient.mockImplementation(() => ({
      assertAuthenticated: () => {
        throw new AuthNotConfiguredError();
      },
    }));
    const errors = capture();
    const { getClient } = await import("../src/util/client.js");

    // then
    expect(() => getClient({ requireAuth: true })).toThrow("process.exit");
    expect(errors.join("\n")).toContain("Not authenticated.");
    expect(errors.join("\n")).toContain(
      "Run 'revx configure' to set up credentials.",
    );
  });

  it("shows a problem found while the client is made like any other error", async () => {
    // given
    const { ConfigurationError } = await import("@revolut/revolut-x-api");
    mockRevolutXClient.mockImplementation(() => {
      throw new ConfigurationError(
        'The API URL (REVOLUTX_API_URL) must start with https://. Got "http://x".',
      );
    });
    const errors = capture();
    const { getClient } = await import("../src/util/client.js");

    // then
    expect(() => getClient()).toThrow("process.exit");
    expect(errors.join("\n")).toContain("✖ Error:");
    expect(errors.join("\n")).toContain("must start with https://");
  });

  it("checks the credentials on every call that needs them", async () => {
    // given
    const assertAuthenticated = vi.fn();
    mockRevolutXClient.mockImplementation(() => ({ assertAuthenticated }));
    const { getClient } = await import("../src/util/client.js");

    // when
    getClient();
    getClient({ requireAuth: true });
    getClient({ requireAuth: true });

    // then
    expect(mockRevolutXClient).toHaveBeenCalledTimes(1);
    expect(assertAuthenticated).toHaveBeenCalledTimes(2);
  });
});
