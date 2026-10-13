import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvalidCredentialsError,
  NotFoundError,
  ServerError,
  ValidationError,
  type CredentialsIssue,
} from "@revolut/revolut-x-api";
import { handleError } from "../src/util/errors.js";

function capture(err: unknown): string {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  expect(() => handleError(err)).toThrow("process.exit");
  return lines.join("\n");
}

describe("handleError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says why the automatic retry after a server error failed", () => {
    // when
    const output = capture(
      new ServerError("Service unavailable", 503, {
        cause: new NotFoundError("Order not found"),
      }),
    );

    // then
    expect(output).toContain("Service unavailable");
    expect(output).toContain(
      "The automatic retry then failed: Order not found.",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("shows a server error with no retry failure on its own", () => {
    // when
    const output = capture(new ServerError("Service unavailable", 503));

    // then
    expect(output).toContain("Service unavailable");
    expect(output).not.toContain("automatic retry");
  });

  it.each<[CredentialsIssue["file"], CredentialsIssue["fault"], string]>([
    [
      "config",
      "unreadable",
      "Make sure the file and its folder belong to you and you can read them, for example: chmod 700 /cfg and chmod 600 /cfg/x.",
    ],
    [
      "config",
      "not_a_file",
      "Move the folder /cfg/x out of the way, then run 'revx configure'.",
    ],
    [
      "config",
      "malformed",
      "Fix the file, or save the API key again with: revx configure set --api-key <key>",
    ],
    [
      "private_key",
      "malformed",
      "Run 'revx configure'. It offers to move this key aside and make a new key pair.",
    ],
    [
      "private_key",
      "missing",
      "If you have a copy of the key, put it back at /cfg/x. Otherwise run 'revx configure' to make a new key pair, register its public key with Revolut X and create a new API key for it.",
    ],
  ])("gives a %s file that is %s its own advice", (file, fault, hint) => {
    // when
    const output = capture(
      new InvalidCredentialsError({
        file,
        fault,
        path: "/cfg/x",
        problem: "The file /cfg/x has a problem.",
        ...(fault === "unreadable" ? { code: "EACCES" } : {}),
      }),
    );

    // then
    expect(output).toContain("The file /cfg/x has a problem.");
    expect(output).toContain(hint);
  });

  it("gives no permission advice for a file behind a broken link", () => {
    // when
    const output = capture(
      new InvalidCredentialsError({
        file: "config",
        fault: "unreadable",
        path: "/cfg/x",
        problem: "The config file /cfg/x can't be read (ELOOP).",
        code: "ELOOP",
      }),
    );

    // then
    expect(output).toContain(
      "Check /cfg/x and fix what stops it from being read, such as a broken link.",
    );
    expect(output).not.toContain("chmod");
  });

  it("lists each validation problem with its field", () => {
    // when
    const output = capture(
      new ValidationError("Invalid order parameters", [
        { path: ["limit", "price"], message: "Expected string" },
        { path: [], message: "Specify a size" },
      ]),
    );

    // then
    expect(output).toContain("Invalid order parameters");
    expect(output).toContain("limit.price: Expected string");
    expect(output).toContain("Specify a size");
  });
});
