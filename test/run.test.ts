import { describe, expect, it } from "vitest";
import {
  ContractError,
  newRun,
  parseCreateRun,
  transition,
} from "../src/run";
import { sandboxCommand, slice1Script } from "../src/sandbox-job";

describe("parseCreateRun", () => {
  it("accepts a trimmed spec", () => {
    expect(parseCreateRun({ spec: "  prove 2+2  " })).toEqual({
      spec: "prove 2+2",
      gitUrl: null,
    });
  });

  it("accepts https gitUrl with optional spec", () => {
    expect(
      parseCreateRun({
        gitUrl: "https://github.com/mtclinton/ways.git",
        spec: "clone ways",
      }),
    ).toEqual({
      spec: "clone ways",
      gitUrl: "https://github.com/mtclinton/ways.git",
    });
  });

  it("accepts gitUrl alone", () => {
    expect(
      parseCreateRun({ gitUrl: "https://github.com/mtclinton/ways.git" }),
    ).toEqual({
      spec: null,
      gitUrl: "https://github.com/mtclinton/ways.git",
    });
  });

  it("rejects ssh gitUrl", () => {
    try {
      parseCreateRun({ gitUrl: "ssh://git@github.com/mtclinton/ways.git" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(422);
    }
  });

  it("rejects file gitUrl", () => {
    try {
      parseCreateRun({ gitUrl: "file:///tmp/repo.git" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(422);
    }
  });

  it("rejects credentials in gitUrl", () => {
    try {
      parseCreateRun({
        gitUrl: "https://user:pass@github.com/mtclinton/ways.git",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(422);
    }
  });

  it("rejects empty body fields", () => {
    try {
      parseCreateRun({});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(400);
    }
  });

  it("rejects empty spec", () => {
    try {
      parseCreateRun({ spec: "   " });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(400);
    }
  });
});

describe("transition", () => {
  it("walks queued → preparing → running → done", () => {
    let state = newRun("r1", "hello", "2026-09-13T00:00:00.000Z");
    state = transition(state, "preparing", "2026-09-13T00:00:01.000Z", "opening");
    state = transition(state, "running", "2026-09-13T00:00:02.000Z", "exec");
    state = transition(state, "done", "2026-09-13T00:00:03.000Z", "ok", {
      result: { stdout: "{}", stderr: "", exitCode: 0 },
    });
    expect(state.phase).toBe("done");
    expect(state.events).toHaveLength(4);
    expect(state.result?.exitCode).toBe(0);
    expect(state.slice).toBe(1);
  });

  it("forbids skipping ahead", () => {
    const state = newRun("r1", "hello", "2026-09-13T00:00:00.000Z");
    try {
      transition(state, "done", "2026-09-13T00:00:01.000Z", "nope");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(409);
    }
  });

  it("marks slice 1.1 when gitUrl present", () => {
    const state = newRun(
      "r2",
      { spec: "x", gitUrl: "https://github.com/mtclinton/ways.git" },
      "2026-09-13T00:00:00.000Z",
    );
    expect(state.slice).toBe(1.1);
    expect(state.gitUrl).toBe("https://github.com/mtclinton/ways.git");
  });
});

describe("sandbox job", () => {
  it("does not break out of the quoted spec", () => {
    const script = slice1Script("it's a spec");
    expect(script).toContain(`'it'\\''s a spec'`);
    expect(sandboxCommand("x").startsWith("bash -lc ")).toBe(true);
  });

  it("does not glue SPEC.txt to uname via collapsed newlines", () => {
    const cmd = sandboxCommand("slice1 smoke");
    expect(cmd).not.toContain("txtnuname");
    expect(cmd).toContain("SPEC.txt");
    expect(cmd).toContain("uname");
    expect(cmd).toContain("; ");
    expect(cmd.startsWith("bash -lc '")).toBe(true);
  });

  it("includes shallow clone when gitUrl set", () => {
    const cmd = sandboxCommand({
      spec: "clone ways",
      gitUrl: "https://github.com/mtclinton/ways.git",
    });
    expect(cmd).toContain("git clone --depth 1 --single-branch");
    expect(cmd).toContain("https://github.com/mtclinton/ways.git");
    expect(cmd).toContain("timeout 30");
    expect(cmd).toContain("slice 1.1");
    expect(cmd).not.toContain("txtnuname");
    expect(cmd.startsWith("bash -lc '")).toBe(true);
  });
});
