import { describe, expect, it } from "vitest";
import {
  ContractError,
  newRun,
  parseCreateRun,
  parseGitRef,
  terminalPhaseForSandbox,
  transition,
  withParsedResultJson,
} from "../src/run";
import {
  EXEC_OUTPUT_LIMIT,
  mapExecuteStatus,
  planExecuteFromPackageJson,
  sandboxCommand,
  slice1Script,
  truncateExecOutput,
} from "../src/sandbox-job";

describe("parseCreateRun", () => {
  it("accepts a trimmed spec", () => {
    expect(parseCreateRun({ spec: "  prove 2+2  " })).toEqual({
      spec: "prove 2+2",
      gitUrl: null,
      gitRef: null,
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
      gitRef: null,
    });
  });

  it("accepts gitUrl alone", () => {
    expect(
      parseCreateRun({ gitUrl: "https://github.com/mtclinton/ways.git" }),
    ).toEqual({
      spec: null,
      gitUrl: "https://github.com/mtclinton/ways.git",
      gitRef: null,
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

  it("marks slice 1.2 when gitUrl present", () => {
    const state = newRun(
      "r2",
      { spec: "x", gitUrl: "https://github.com/mtclinton/ways.git", gitRef: null },
      "2026-09-13T00:00:00.000Z",
    );
    expect(state.slice).toBe(1.2);
    expect(state.gitUrl).toBe("https://github.com/mtclinton/ways.git");
  });
});

describe("execute status + truncation", () => {
  it("maps exit codes to execute.status", () => {
    expect(mapExecuteStatus(0)).toBe("ok");
    expect(mapExecuteStatus(1)).toBe("failed");
    expect(mapExecuteStatus(124)).toBe("timeout");
    expect(mapExecuteStatus(null)).toBe("failed");
  });

  it("truncates execute output to 8KB", () => {
    const big = "a".repeat(EXEC_OUTPUT_LIMIT + 50);
    const out = truncateExecOutput(big);
    expect(new TextEncoder().encode(out).length).toBe(EXEC_OUTPUT_LIMIT);
    expect(truncateExecOutput("short")).toBe("short");
  });
});

describe("slice 1.2.1 phase vs execute", () => {
  it("clone ok + execute timeout → done", () => {
    const result = withParsedResultJson({
      stdout: JSON.stringify({
        slice: 1.2,
        clone: "ok",
        execute: { status: "timeout", exitCode: 124 },
      }),
      stderr: "",
      exitCode: 0,
    });
    expect(result.json).toMatchObject({ clone: "ok" });
    expect(
      terminalPhaseForSandbox("https://github.com/mtclinton/ways.git", result),
    ).toBe("done");
  });

  it("clone failed → failed", () => {
    const result = withParsedResultJson({
      stdout: JSON.stringify({
        slice: 1.2,
        clone: "failed",
        execute: { status: "skipped", exitCode: null },
      }),
      stderr: "clone err",
      exitCode: 1,
    });
    expect(
      terminalPhaseForSandbox("https://github.com/mtclinton/ways.git", result),
    ).toBe("failed");
  });

  it("gitUrl script exits only on clone failure", () => {
    const script = slice1Script({
      spec: "x",
      gitUrl: "https://github.com/mtclinton/ways.git",
      gitRef: null,
    });
    expect(script).toContain('if [ "$CLONE" != "ok" ]; then exit 1; fi');
    expect(script).not.toContain(
      'if [ "$EXEC_STATUS" = "failed" ] || [ "$EXEC_STATUS" = "timeout" ]; then exit 1; fi',
    );
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
    expect(cmd).toContain("; ");
    expect(cmd.startsWith("bash -lc '")).toBe(true);
  });

  it("includes shallow clone + heavy-install skip when gitUrl set", () => {
    const cmd = sandboxCommand({
      spec: "clone ways",
      gitUrl: "https://github.com/mtclinton/ways.git",
      gitRef: null,
    });
    expect(cmd).toContain("git clone --depth 1 --single-branch");
    expect(cmd).toContain("heavy-install");
    expect(cmd).toContain("npm install --omit=dev --no-audit --no-fund");
    expect(cmd).toContain("timeout 30");
    expect(cmd).not.toContain("timeout 60");
    expect(cmd).toContain("slice 1.2");
    expect(cmd).not.toContain("txtnuname");
    expect(cmd.startsWith("bash -lc '")).toBe(true);
  });
});

describe("slice 1.2.2 heavy-install skip", () => {
  it("skips when package.json lists wrangler in devDependencies", () => {
    expect(
      planExecuteFromPackageJson({
        name: "ways",
        devDependencies: { wrangler: "^4.40.0", vitest: "^3.2.0" },
      }),
    ).toEqual({ action: "skip", reason: "heavy-install" });
  });

  it("skips next/vite/webpack/@cloudflare/vite-plugin", () => {
    for (const name of ["next", "vite", "webpack", "@cloudflare/vite-plugin"]) {
      expect(
        planExecuteFromPackageJson({ dependencies: { [name]: "1.0.0" } }),
      ).toEqual({ action: "skip", reason: "heavy-install" });
    }
  });

  it("runs install-then-test for a light package.json", () => {
    expect(
      planExecuteFromPackageJson({
        dependencies: { leftpad: "1.0.0" },
      }),
    ).toEqual({ action: "install-then-test" });
  });
});

import { RUN_INDEX_CAP, upsertRunIndex } from "../src/run-index";

describe("run index", () => {
  it("inserts newest-first and replaces by id", () => {
    let runs = upsertRunIndex([], {
      id: "a",
      phase: "queued",
      createdAt: "2026-09-14T01:00:00.000Z",
      spec: "one",
    });
    runs = upsertRunIndex(runs, {
      id: "b",
      phase: "queued",
      createdAt: "2026-09-14T02:00:00.000Z",
      spec: "two",
    });
    expect(runs.map((r) => r.id)).toEqual(["b", "a"]);
    runs = upsertRunIndex(runs, {
      id: "a",
      phase: "done",
      createdAt: "2026-09-14T01:00:00.000Z",
      spec: "one",
      execute: { status: "ok" },
    });
    expect(runs[0].id).toBe("b");
    expect(runs.find((r) => r.id === "a")?.phase).toBe("done");
    expect(runs.find((r) => r.id === "a")?.execute).toEqual({ status: "ok" });
  });

  it("caps at 50", () => {
    let runs = [];
    for (let i = 0; i < RUN_INDEX_CAP + 5; i++) {
      const n = String(i).padStart(2, "0");
      runs = upsertRunIndex(runs, {
        id: `id-${n}`,
        phase: "queued",
        createdAt: `2026-09-14T00:00:${n}.000Z`,
      });
    }
    expect(runs).toHaveLength(RUN_INDEX_CAP);
    expect(runs[0].id).toBe("id-54");
  });
});


import {
  previewAbsolutePath,
  resolvePreviewFromExists,
} from "../src/preview";

describe("slice 1.4 preview", () => {
  it("maps public/index.html ahead of root index.html", () => {
    expect(resolvePreviewFromExists(true, true)).toEqual({
      status: "ready",
      path: "public/index.html",
    });
    expect(resolvePreviewFromExists(false, true)).toEqual({
      status: "ready",
      path: "index.html",
    });
    expect(resolvePreviewFromExists(false, false)).toEqual({
      status: "skipped",
      reason: "no-static-index",
    });
  });

  it("allowlists only the two paths and bans traversal", () => {
    expect(previewAbsolutePath("public/index.html")).toBe(
      "/workspace/run/src/public/index.html",
    );
    expect(previewAbsolutePath("index.html")).toBe(
      "/workspace/run/src/index.html",
    );
    expect(previewAbsolutePath("../etc/passwd")).toBeNull();
    expect(previewAbsolutePath("public/../index.html")).toBeNull();
    expect(previewAbsolutePath("/index.html")).toBeNull();
  });
});


import {
  assertDeployOutputSafe,
  assertDeletablePreviewWorkerName,
  assertSafePreviewWorkerName,
  isDeletablePreviewWorkerName,
  parsePreviewWorkerUrl,
  parseWranglerJsonc,
  previewWorkerName,
} from "../src/worker-preview";

describe("slice 1.5 worker preview name", () => {
  it("derives ways-p-<first8>", () => {
    expect(previewWorkerName("7409a176-238d-4515-8e00-d446cf7ca095")).toBe(
      "ways-p-7409a176",
    );
  });

  it("rejects banned names ways and do-not-use-this-name", () => {
    expect(() => assertSafePreviewWorkerName("ways")).toThrow(/banned/);
    expect(() => assertSafePreviewWorkerName("do-not-use-this-name")).toThrow(
      /banned/,
    );
    expect(assertSafePreviewWorkerName("ways-p-7409a176")).toBe(
      "ways-p-7409a176",
    );
  });

  it("fails deploy output that mentions banned names", () => {
    expect(() =>
      assertDeployOutputSafe("Uploaded do-not-use-this-name", "ways-p-abcd1234"),
    ).toThrow(/banned/);
    expect(() =>
      assertDeployOutputSafe("Deployed ways triggers", "ways-p-abcd1234"),
    ).toThrow(/banned/);
    expect(() =>
      assertDeployOutputSafe(
        "Deployed ways-p-7409a176\n  https://ways-p-7409a176.max-977.workers.dev",
        "ways-p-7409a176",
      ),
    ).not.toThrow();
  });

  it("parses wrangler.jsonc main without using cloned name", () => {
    const cfg = parseWranglerJsonc(`{
  // comment
  "name": "do-not-use-this-name",
  "main": "src/index.js",
  "compatibility_date": "2026-09-01"
}`);
    expect(cfg.main).toBe("src/index.js");
    expect(cfg.name).toBe("do-not-use-this-name");
    // deploy must still use forced name, never cfg.name
    expect(previewWorkerName("abcd1234-xxxx")).toBe("ways-p-abcd1234");
    expect(() => assertSafePreviewWorkerName(cfg.name!)).toThrow(/banned/);
  });

  it("parses workers.dev URL for forced name", () => {
    const out = `Deployed ways-p-abcd1234\n  https://ways-p-abcd1234.max-977.workers.dev\n`;
    expect(parsePreviewWorkerUrl(out, "ways-p-abcd1234")).toBe(
      "https://ways-p-abcd1234.max-977.workers.dev",
    );
  });
});


describe("slice 1.6 deletable preview name", () => {
  it("accepts ways-p-<8 lowercase hex>", () => {
    expect(isDeletablePreviewWorkerName("ways-p-abcd1234")).toBe(true);
    expect(assertDeletablePreviewWorkerName("ways-p-abcd1234")).toBe(
      "ways-p-abcd1234",
    );
  });

  it("rejects ways, do-not-use-this-name, ways-p-toolong, uppercase hex", () => {
    expect(isDeletablePreviewWorkerName("ways")).toBe(false);
    expect(isDeletablePreviewWorkerName("do-not-use-this-name")).toBe(false);
    expect(isDeletablePreviewWorkerName("ways-p-toolong")).toBe(false);
    expect(isDeletablePreviewWorkerName("ways-p-ABCD1234")).toBe(false);
    expect(() => assertDeletablePreviewWorkerName("ways")).toThrow(/deletable/);
    expect(() =>
      assertDeletablePreviewWorkerName("do-not-use-this-name"),
    ).toThrow(/deletable/);
    expect(() => assertDeletablePreviewWorkerName("ways-p-toolong")).toThrow(
      /deletable/,
    );
    expect(() => assertDeletablePreviewWorkerName("ways-p-ABCD1234")).toThrow(
      /deletable/,
    );
  });
});


describe("slice 1.7 gitRef", () => {
  it("accepts main, 40-hex, and branch names", () => {
    expect(parseGitRef("main")).toBe("main");
    expect(parseGitRef("slice1-no-artifacts")).toBe("slice1-no-artifacts");
    const sha = "d31b843947369d6368074ad98197c874f102bbb7";
    expect(parseGitRef(sha)).toBe(sha);
    expect(
      parseCreateRun({
        spec: "x",
        gitUrl: "https://github.com/mtclinton/ways.git",
        gitRef: "main",
      }),
    ).toEqual({
      spec: "x",
      gitUrl: "https://github.com/mtclinton/ways.git",
      gitRef: "main",
    });
  });

  it("rejects ../, foo bar, empty, leading -, and ..", () => {
    for (const bad of ["../", "../evil", "foo bar", "", "  ", "-", "-main", ".."]) {
      try {
        parseGitRef(bad);
        throw new Error(`expected throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ContractError);
        expect((err as ContractError).status).toBe(422);
      }
    }
    try {
      parseCreateRun({
        spec: "x",
        gitUrl: "https://github.com/mtclinton/ways-fixture.git",
        gitRef: "../evil",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(422);
    }
  });

  it("clones with --branch when gitRef set and includes gitRef in RESULT jq", () => {
    const script = slice1Script({
      spec: "x",
      gitUrl: "https://github.com/mtclinton/ways.git",
      gitRef: "slice1-no-artifacts",
    });
    expect(script).toContain("git clone --depth 1 --branch");
    expect(script).toContain("slice1-no-artifacts");
    expect(script).toContain("fetch --depth 1 origin");
    expect(script).toContain("--arg gitRef");
    expect(script).toContain("gitRef:(if $gitRef==\"\" then null else $gitRef end)");
  });

  it("omits --branch when gitRef null; still emits gitRef null in RESULT", () => {
    const script = slice1Script({
      spec: "x",
      gitUrl: "https://github.com/mtclinton/ways.git",
      gitRef: null,
    });
    expect(script).toContain("git clone --depth 1 --single-branch");
    expect(script).not.toContain("git clone --depth 1 --branch");
    expect(script).toContain("--arg gitRef");
  });

  it("stores gitRef on RunState", () => {
    const state = newRun(
      "r3",
      {
        spec: "x",
        gitUrl: "https://github.com/mtclinton/ways.git",
        gitRef: "main",
      },
      "2026-09-14T00:00:00.000Z",
    );
    expect(state.gitRef).toBe("main");
  });
});


import {
  assertNoUserinfoInGitUrl,
  buildGithubAuthExtraHeader,
  isGithubHttpsUrl,
  resultGitUrl,
  scrubTokenFromText,
} from "../src/git-auth";

describe("slice 1.8 git auth", () => {
  it("isGithubHttpsUrl accepts github.com https only", () => {
    expect(isGithubHttpsUrl("https://github.com/mtclinton/ways.git")).toBe(true);
    expect(isGithubHttpsUrl("https://www.github.com/mtclinton/ways.git")).toBe(
      true,
    );
    expect(isGithubHttpsUrl("https://gitlab.com/mtclinton/ways.git")).toBe(false);
    expect(isGithubHttpsUrl("http://github.com/mtclinton/ways.git")).toBe(false);
    expect(isGithubHttpsUrl("not-a-url")).toBe(false);
  });

  it("buildGithubAuthExtraHeader formats Basic x-access-token without logging real tokens", () => {
    const fake = "ghp_TEST_FAKE_TOKEN_FOR_UNIT_ONLY";
    const header = buildGithubAuthExtraHeader(fake);
    expect(header.startsWith("Authorization: Basic ")).toBe(true);
    const b64 = header.slice("Authorization: Basic ".length);
    expect(atob(b64)).toBe(`x-access-token:${fake}`);
  });

  it("assertNoUserinfoInGitUrl / resultGitUrl reject credentials", () => {
    expect(() =>
      assertNoUserinfoInGitUrl(
        "https://x-access-token:gho_fake@github.com/mtclinton/ways.git",
      ),
    ).toThrow(/userinfo/);
    expect(() =>
      resultGitUrl("https://user:pass@github.com/mtclinton/ways.git"),
    ).toThrow(/userinfo/);
    expect(resultGitUrl("https://github.com/mtclinton/ways.git")).toBe(
      "https://github.com/mtclinton/ways.git",
    );
  });

  it("posted gitUrl with userinfo still rejected by parseGitUrl", () => {
    try {
      parseCreateRun({
        gitUrl: "https://x-access-token:gho_fake@github.com/mtclinton/ways.git",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).status).toBe(422);
    }
  });

  it("RESULT jq uses original URL; script has auth retry for github, not tokenized URL", () => {
    const original = "https://github.com/mtclinton/ways-private-fixture.git";
    const script = slice1Script({
      spec: "1.8",
      gitUrl: original,
      gitRef: null,
    });
    expect(script).toContain(`--arg gitUrl '${original}'`);
    expect(script).toContain("Authorization: Basic ${AUTH_B64}");
    expect(script).toContain('GITHUB_TOKEN:-');
    expect(script).toContain("http.extraHeader");
    expect(script).toContain('printf "%s" "x-access-token:${GITHUB_TOKEN}"');
    // Must not embed credentials as URL userinfo
    expect(script).not.toMatch(/https:\/\/[^'"\s]+@github\.com/);
    expect(script).not.toContain("@github.com/");
    expect(script).toContain('sed -i "s|${GITHUB_TOKEN}|***|g"');
    // tokenized URL helper must not be used for RESULT
    expect(resultGitUrl(original)).toBe(original);
  });

  it("non-github https URL has no GITHUB_TOKEN auth retry", () => {
    const script = slice1Script({
      spec: "x",
      gitUrl: "https://example.com/org/repo.git",
      gitRef: null,
    });
    expect(script).not.toContain("GITHUB_TOKEN");
    expect(script).not.toContain("http.extraHeader");
    expect(script).toContain("git clone --depth 1 --single-branch");
  });

  it("scrubTokenFromText redacts token", () => {
    expect(scrubTokenFromText("err ghp_ABC xyz ghp_ABC", "ghp_ABC")).toBe(
      "err *** xyz ***",
    );
    expect(scrubTokenFromText("clean", undefined)).toBe("clean");
  });

  it("gitRef-aware clone still includes auth retry on github", () => {
    const script = slice1Script({
      spec: "x",
      gitUrl: "https://github.com/mtclinton/ways.git",
      gitRef: "main",
    });
    expect(script).toContain("git clone --depth 1 --branch");
    expect(script).toContain("Authorization: Basic ${AUTH_B64}");
    expect(script).toContain("fetch --depth 1 origin");
  });
});
