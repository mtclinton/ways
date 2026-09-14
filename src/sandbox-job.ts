/** Shell the sandbox runs. Keep it boring and deterministic. */

export const EXEC_OUTPUT_LIMIT = 8 * 1024;

export type ExecuteStatus = "ok" | "failed" | "skipped" | "timeout";

export type SkipReason =
  | "no-package-json"
  | "heavy-install"
  | "install-timeout"
  | "install-failed";

export const HEAVY_INSTALL_PACKAGES = [
  "wrangler",
  "next",
  "vite",
  "webpack",
  "@cloudflare/vite-plugin",
] as const;

export type SandboxJobInput = {
  spec: string | null;
  gitUrl: string | null;
};

function sq(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/** Truncate by UTF-8 bytes (for RESULT execute.stdout/stderr). */
export function truncateExecOutput(
  text: string,
  limit = EXEC_OUTPUT_LIMIT,
): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.slice(0, limit));
}

/** Map a process exit code from `timeout(1)` / npm test to execute.status. */
export function mapExecuteStatus(exitCode: number | null): ExecuteStatus {
  if (exitCode === null) return "failed";
  if (exitCode === 124) return "timeout"; // GNU timeout
  if (exitCode === 0) return "ok";
  return "failed";
}

export type ExecutePlan =
  | { action: "skip"; reason: SkipReason }
  | { action: "install-then-test" };

/** Decide whether a cloned package.json is safe to install on a lite sandbox. */
export function planExecuteFromPackageJson(pkg: unknown): ExecutePlan {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    return { action: "skip", reason: "no-package-json" };
  }
  const rec = pkg as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const deps = {
    ...(rec.dependencies ?? {}),
    ...(rec.devDependencies ?? {}),
  };
  for (const name of HEAVY_INSTALL_PACKAGES) {
    if (Object.prototype.hasOwnProperty.call(deps, name)) {
      return { action: "skip", reason: "heavy-install" };
    }
  }
  return { action: "install-then-test" };
}

/** jq filter: true if package.json has a heavy install package. */
export const HEAVY_INSTALL_JQ =
  '(.dependencies // {}) + (.devDependencies // {}) | keys | any(. == "wrangler" or . == "next" or . == "vite" or . == "webpack" or . == "@cloudflare/vite-plugin")';

/** Build the inner bash script (newline-separated). */
export function slice1Script(input: SandboxJobInput | string): string {
  const job: SandboxJobInput =
    typeof input === "string" ? { spec: input, gitUrl: null } : input;
  const spec = job.spec ?? "";
  const gitUrl = job.gitUrl;

  const lines: string[] = [
    "set -eu",
    "mkdir -p /workspace/run",
    `printf '%s' '${sq(spec)}' > /workspace/run/SPEC.txt`,
  ];

  if (gitUrl) {
    // Slice 1.2.2 execute block — keep as one bash line for "; " joining.
    const executeBlock = [
      'if [ "$CLONE" = "ok" ]; then',
      '  : > /workspace/run/EXEC_STDOUT.raw; : > /workspace/run/EXEC_STDERR.raw;',
      '  if [ ! -f /workspace/run/src/package.json ]; then',
      '    EXEC_STATUS=skipped; EXEC_REASON=no-package-json; EXEC_EC=;',
      '  elif jq -e \'' +
        HEAVY_INSTALL_JQ +
        '\' /workspace/run/src/package.json >/dev/null 2>&1; then',
      '    EXEC_STATUS=skipped; EXEC_REASON=heavy-install; EXEC_EC=;',
      '  else',
      '    set +e;',
      '    timeout 30 npm install --omit=dev --no-audit --no-fund --prefix /workspace/run/src > /workspace/run/EXEC_INSTALL_OUT.txt 2> /workspace/run/EXEC_INSTALL_ERR.txt;',
      '    INST_EC=$?;',
      '    if [ "$INST_EC" -eq 124 ]; then',
      '      EXEC_STATUS=skipped; EXEC_REASON=install-timeout; EXEC_EC=124;',
      '      cp /workspace/run/EXEC_INSTALL_OUT.txt /workspace/run/EXEC_STDOUT.raw;',
      '      cp /workspace/run/EXEC_INSTALL_ERR.txt /workspace/run/EXEC_STDERR.raw;',
      '    elif [ "$INST_EC" -ne 0 ]; then',
      '      EXEC_STATUS=skipped; EXEC_REASON=install-failed; EXEC_EC=$INST_EC;',
      '      cp /workspace/run/EXEC_INSTALL_OUT.txt /workspace/run/EXEC_STDOUT.raw;',
      '      cp /workspace/run/EXEC_INSTALL_ERR.txt /workspace/run/EXEC_STDERR.raw;',
      '    else',
      '      timeout 30 npm test --prefix /workspace/run/src > /workspace/run/EXEC_TEST_OUT.txt 2> /workspace/run/EXEC_TEST_ERR.txt;',
      '      TEST_EC=$?; EXEC_EC=$TEST_EC; EXEC_REASON=;',
      '      cp /workspace/run/EXEC_TEST_OUT.txt /workspace/run/EXEC_STDOUT.raw;',
      '      cp /workspace/run/EXEC_TEST_ERR.txt /workspace/run/EXEC_STDERR.raw;',
      '      if [ "$TEST_EC" -eq 124 ]; then EXEC_STATUS=timeout;',
      '      elif [ "$TEST_EC" -eq 0 ]; then EXEC_STATUS=ok;',
      '      else EXEC_STATUS=failed; fi;',
      '    fi;',
      '    set -e;',
      '  fi;',
      'else',
      '  : > /workspace/run/EXEC_STDOUT.raw; : > /workspace/run/EXEC_STDERR.raw;',
      'fi',
    ].join(" ");

    lines.push(
      `printf '%s' '${sq(gitUrl)}' > /workspace/run/GITURL.txt`,
      "CLONE=failed",
      "HEAD=",
      "EXEC_STATUS=skipped",
      "EXEC_REASON=",
      "EXEC_EC=",
      "PREVIEW_STATUS=skipped",
      "PREVIEW_PATH=",
      "PREVIEW_REASON=no-static-index",
      "set +e",
      `timeout 30 git clone --depth 1 --single-branch '${sq(gitUrl)}' /workspace/run/src > /workspace/run/CLONE_STDERR.txt 2>&1`,
      "CLONE_EC=$?",
      "set -e",
      'if [ "$CLONE_EC" -eq 0 ]; then CLONE=ok; HEAD=$(git -C /workspace/run/src rev-parse HEAD | tr -d "\\n"); else cat /workspace/run/CLONE_STDERR.txt >&2 || true; fi',
      executeBlock,
      'if [ "$CLONE" = "ok" ]; then if [ -f /workspace/run/src/public/index.html ]; then PREVIEW_STATUS=ready; PREVIEW_PATH=public/index.html; PREVIEW_REASON=; elif [ -f /workspace/run/src/index.html ]; then PREVIEW_STATUS=ready; PREVIEW_PATH=index.html; PREVIEW_REASON=; fi; fi',
      "head -c 8192 /workspace/run/EXEC_STDOUT.raw > /workspace/run/EXEC_STDOUT.txt || :",
      "head -c 8192 /workspace/run/EXEC_STDERR.raw > /workspace/run/EXEC_STDERR.txt || :",
      'HOST=$(uname -a | tr -d "\\n")',
      'FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ | tr -d "\\n")',
      `jq -n --argjson slice 1.2 --rawfile spec /workspace/run/SPEC.txt --arg gitUrl '${sq(gitUrl)}' --arg clone "$CLONE" --arg head "$HEAD" --arg host "$HOST" --arg finishedAt "$FINISHED" --arg execStatus "$EXEC_STATUS" --arg execEc "$EXEC_EC" --arg execReason "$EXEC_REASON" --arg previewStatus "$PREVIEW_STATUS" --arg previewPath "$PREVIEW_PATH" --arg previewReason "$PREVIEW_REASON" --rawfile execOut /workspace/run/EXEC_STDOUT.txt --rawfile execErr /workspace/run/EXEC_STDERR.txt '{slice:$slice, spec:(if $spec=="" then null else $spec end), gitUrl:$gitUrl, clone:$clone, head:(if $head=="" then null else $head end), host:$host, finishedAt:$finishedAt, execute:({status:$execStatus, exitCode:(if $execEc=="" then null else ($execEc|tonumber) end), stdout:$execOut, stderr:$execErr} + (if $execReason=="" then {} else {reason:$execReason} end)), preview:(if $previewStatus=="ready" then {status:"ready", path:$previewPath} else {status:"skipped", reason:$previewReason} end)}' > /workspace/run/RESULT.json`,
      "cat /workspace/run/RESULT.json",
      // Slice 1.2.1: clone failure fails the run; execute* → exit 0
      'if [ "$CLONE" != "ok" ]; then exit 1; fi',
    );
  } else {
    lines.push(
      'HOST=$(uname -a | tr -d "\\n")',
      'FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ | tr -d "\\n")',
      `jq -n --argjson slice 1 --rawfile spec /workspace/run/SPEC.txt --arg host "$HOST" --arg finishedAt "$FINISHED" '{slice:$slice, spec:$spec, host:$host, finishedAt:$finishedAt}' > /workspace/run/RESULT.json`,
      "cat /workspace/run/RESULT.json",
    );
  }

  return lines.join("\n");
}

export function sandboxCommand(input: SandboxJobInput | string): string {
  // bash -lc "..." (via JSON.stringify) collapses \n → n and expands $vars.
  // Prefer a single-line script joined with "; ", wrapped in single quotes.
  const script = slice1Script(input).replace(/\n/g, "; ");
  const quoted = script.replace(/'/g, `'\\''`);
  return `bash -lc '${quoted}'`;
}
