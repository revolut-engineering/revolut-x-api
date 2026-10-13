import { describe, expect, it } from "vitest";
import { createProgram } from "../src/index.js";

describe("revx program", () => {
  it("offers no events command, since nothing ever recorded events", () => {
    // given
    const program = createProgram();
    let help = "";
    program.configureOutput({ writeOut: (text) => (help += text) });

    // when
    program.outputHelp();

    // then
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("monitor");
    expect(names).not.toContain("events");
    expect(help).toContain("revx monitor");
    expect(help).not.toContain("revx events");
  });
});
