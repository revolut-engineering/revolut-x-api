import { afterEach, describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "../src/config/base-url.js";
import { RevolutXClient } from "../src/client.js";
import { ConfigurationError } from "../src/http/errors.js";

const SOURCE = "The API URL (REVOLUTX_API_URL)";

describe("normalizeBaseUrl", () => {
  it.each([
    ["https://revx.revolut.com", "https://revx.revolut.com"],
    ["https://revx.revolut.com/", "https://revx.revolut.com"],
    ["https://revx.revolut.codes//", "https://revx.revolut.codes"],
    ["https://revx.revolut.com:443", "https://revx.revolut.com"],
    [" HTTPS://Revx.Revolut.com ", "https://revx.revolut.com"],
    ["https://proxy.example/revx/", "https://proxy.example/revx"],
    ["http://127.0.0.1:8789", "http://127.0.0.1:8789"],
    ["http://localhost:8789/", "http://localhost:8789"],
    ["http://[::1]:8789", "http://[::1]:8789"],
  ])("reads %j as %j", (value, expected) => {
    expect(normalizeBaseUrl(value, SOURCE)).toBe(expected);
  });

  it.each([
    "https://revx.revolut.codes/api",
    "https://revx.revolut.com/api/1.0/",
    "https://proxy.example/revx/API",
  ])("refuses %j, which repeats the path the client adds", (value) => {
    expect(() => normalizeBaseUrl(value, SOURCE)).toThrow(
      `${SOURCE} must not end with /api or /api/1.0. The client adds /api/1.0 itself. Got "${value.trim()}".`,
    );
  });

  it.each(["https://revx.revolut.com?x=1", "https://revx.revolut.com#top"])(
    "refuses %j, which has a query or fragment",
    (value) => {
      expect(() => normalizeBaseUrl(value, SOURCE)).toThrow(
        `${SOURCE} must not contain "?" or "#".`,
      );
    },
  );

  it.each([
    "revx.revolut.com",
    "ftp://revx.revolut.com",
    "not a url",
    "",
    "https://revx.revolut.com:99999",
  ])("refuses %j, which is not a web address", (value) => {
    expect(() => normalizeBaseUrl(value, SOURCE)).toThrow(
      `${SOURCE} must be a web address such as https://revx.revolut.com.`,
    );
  });

  it("refuses plain http to a name under localhost, which DNS may send elsewhere", () => {
    expect(() => normalizeBaseUrl("http://app.localhost:8789", SOURCE)).toThrow(
      `${SOURCE} must start with https://. Plain http:// is allowed only for this machine (localhost, 127.x.x.x or [::1]). Got "http://app.localhost:8789".`,
    );
  });

  it("refuses plain http to another machine", () => {
    expect(() => normalizeBaseUrl("http://revx.revolut.com", SOURCE)).toThrow(
      `${SOURCE} must start with https://. Plain http:// is allowed only for this machine (localhost, 127.x.x.x or [::1]). Got "http://revx.revolut.com".`,
    );
  });

  it("refuses a user name or password and never repeats them", () => {
    const attempt = () =>
      normalizeBaseUrl("https://user:s3cret@revx.revolut.com", SOURCE);

    expect(attempt).toThrow(ConfigurationError);
    expect(attempt).toThrow(
      `${SOURCE} must not contain a user name or password. Got "https://***@revx.revolut.com".`,
    );
  });

  it.each([
    "https://bob:se#cret@revx.revolut.com",
    "https://bob:se/cret@revx.revolut.com",
    "https://bob:se?cret@revx.revolut.com",
  ])("never repeats the password in %j", (value) => {
    let message = "";
    try {
      normalizeBaseUrl(value, SOURCE);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toContain("cret");
    expect(message).toContain("//***@revx.revolut.com");
  });

  it.each([
    "http:user:secretpw@127.0.0.1:9",
    "http:/user:secretpw@example.com",
    "http:\\\\user:secretpw@example.com",
    "http://us\ner:secretpw@example.com",
  ])("never repeats the password in the unusual form %j", (value) => {
    let message = "";
    try {
      normalizeBaseUrl(value, SOURCE);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("***@");
    expect(message).not.toContain("secretpw");
  });

  it("keeps an @ that is part of the path", () => {
    expect(() => normalizeBaseUrl("http://example.com/a@b", SOURCE)).toThrow(
      'Got "http://example.com/a@b".',
    );
  });

  it.each([
    ["admin:SECRETPW@revx.example.com", "admin:***@revx.example.com"],
    ["mailto:SECRETPW@x", "mailto:***@x"],
    ["blob:https://user:SECRETPW@host/x", "blob:***@host/x"],
  ])("hides the password in %j, which has no host", (value, expected) => {
    expect(() => normalizeBaseUrl(value, SOURCE)).toThrow(`Got "${expected}".`);
  });

  it.each([
    ["revx.revolut.com?token=SECRET", "revx.revolut.com?***"],
    ["localhost:8080#SECRET", "localhost:8080#***"],
    ["https://exa mple.com/?token=SECRET", "https://exa mple.com/?***"],
  ])("hides the query or fragment of %j, which has no host", (value, shown) => {
    expect(() => normalizeBaseUrl(value, SOURCE)).toThrow(`Got "${shown}".`);
  });

  it("hides a query and a fragment", () => {
    expect(() =>
      normalizeBaseUrl("https://revx.revolut.com/?token=SECRET#frag", SOURCE),
    ).toThrow('Got "https://revx.revolut.com?***#***".');
  });

  it("refuses port 0", () => {
    expect(() => normalizeBaseUrl("http://localhost:0", SOURCE)).toThrow(
      `${SOURCE} must not use port 0.`,
    );
  });

  it("hides a password in an address it can't read", () => {
    expect(() =>
      normalizeBaseUrl("http://user:s3cret@127.0.0.1:99999/x", SOURCE),
    ).toThrow('Got "http://***@127.0.0.1:99999/x".');
  });
});

describe("client base URL", () => {
  const previous = process.env.REVOLUTX_API_URL;

  afterEach(() => {
    if (previous === undefined) delete process.env.REVOLUTX_API_URL;
    else process.env.REVOLUTX_API_URL = previous;
  });

  it("refuses a wrong environment address when the client is made", () => {
    process.env.REVOLUTX_API_URL = "https://revx.revolut.codes/api";
    expect(() => new RevolutXClient({ autoLoadCredentials: false })).toThrow(
      `${SOURCE} must not end with /api or /api/1.0.`,
    );
  });

  it.each(["", "   "])(
    "uses the default address when the environment address is %j",
    (value) => {
      process.env.REVOLUTX_API_URL = value;
      expect(
        () => new RevolutXClient({ autoLoadCredentials: false }),
      ).not.toThrow();
    },
  );

  it("names the option when the option address is wrong", () => {
    expect(
      () =>
        new RevolutXClient({
          autoLoadCredentials: false,
          baseUrl: "http://revx.revolut.com",
        }),
    ).toThrow("The baseUrl option must start with https://.");
  });

  it("accepts an option address with a trailing slash", () => {
    expect(
      () =>
        new RevolutXClient({
          autoLoadCredentials: false,
          baseUrl: "https://revx.revolut.com/",
        }),
    ).not.toThrow();
  });
});
