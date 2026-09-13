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
    });
  });

  it("rejects gitUrl in slice 1", () => {
    try {
      parseCreateRun({ spec: "x", gitUrl: "https://example.com/r.git" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(422);
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
    expect(cmd).toContain("; uname -a");
    // single-quoted -lc so jq $spec is not expanded by the wrapper shell
    expect(cmd.startsWith("bash -lc '")).toBe(true);
    expect(cmd).toContain("spec:$spec");
  });
});
