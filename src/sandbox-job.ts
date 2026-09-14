/** Shell the sandbox runs. Keep it boring and deterministic. */

export const EXEC_OUTPUT_LIMIT = 8 * 1024;

export type ExecuteStatus = "ok" | "failed" | "skipped" | "timeout";

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

/** Map a process exit code from `timeout(1)` / npm to execute.status. */
export function mapExecuteStatus(exitCode: number | null): ExecuteStatus {
  if (exitCode === null) return "failed";
  if (exitCode === 124) return "timeout"; // GNU timeout
  if (exitCode === 0) return "ok";
  return "failed";
}

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
    lines.push(
      `printf '%s' '${sq(gitUrl)}' > /workspace/run/GITURL.txt`,
      "CLONE=failed",
      "HEAD=",
      "EXEC_STATUS=skipped",
      "EXEC_EC=",
      "set +e",
      `timeout 30 git clone --depth 1 --single-branch '${sq(gitUrl)}' /workspace/run/src > /workspace/run/CLONE_STDERR.txt 2>&1`,
      "CLONE_EC=$?",
      "set -e",
      'if [ "$CLONE_EC" -eq 0 ]; then CLONE=ok; HEAD=$(git -C /workspace/run/src rev-parse HEAD | tr -d "\\n"); else cat /workspace/run/CLONE_STDERR.txt >&2 || true; fi',
      // Slice 1.2 execute — only after successful clone. spec is never executed.
      'if [ "$CLONE" = "ok" ]; then if [ -f /workspace/run/src/package.json ]; then set +e; timeout 60 npm install --omit=dev --prefix /workspace/run/src > /workspace/run/EXEC_INSTALL_OUT.txt 2> /workspace/run/EXEC_INSTALL_ERR.txt; INST_EC=$?; if [ "$INST_EC" -eq 124 ]; then EXEC_STATUS=timeout; EXEC_EC=124; cp /workspace/run/EXEC_INSTALL_OUT.txt /workspace/run/EXEC_STDOUT.raw; cp /workspace/run/EXEC_INSTALL_ERR.txt /workspace/run/EXEC_STDERR.raw; elif [ "$INST_EC" -ne 0 ]; then EXEC_STATUS=failed; EXEC_EC=$INST_EC; cp /workspace/run/EXEC_INSTALL_OUT.txt /workspace/run/EXEC_STDOUT.raw; cp /workspace/run/EXEC_INSTALL_ERR.txt /workspace/run/EXEC_STDERR.raw; else timeout 60 npm test --prefix /workspace/run/src > /workspace/run/EXEC_TEST_OUT.txt 2> /workspace/run/EXEC_TEST_ERR.txt; TEST_EC=$?; EXEC_EC=$TEST_EC; cp /workspace/run/EXEC_TEST_OUT.txt /workspace/run/EXEC_STDOUT.raw; cp /workspace/run/EXEC_TEST_ERR.txt /workspace/run/EXEC_STDERR.raw; if [ "$TEST_EC" -eq 124 ]; then EXEC_STATUS=timeout; elif [ "$TEST_EC" -eq 0 ]; then EXEC_STATUS=ok; else EXEC_STATUS=failed; fi; fi; set -e; else EXEC_STATUS=skipped; EXEC_EC=; : > /workspace/run/EXEC_STDOUT.raw; : > /workspace/run/EXEC_STDERR.raw; fi; else : > /workspace/run/EXEC_STDOUT.raw; : > /workspace/run/EXEC_STDERR.raw; fi',
      "head -c 8192 /workspace/run/EXEC_STDOUT.raw > /workspace/run/EXEC_STDOUT.txt || :",
      "head -c 8192 /workspace/run/EXEC_STDERR.raw > /workspace/run/EXEC_STDERR.txt || :",
      'HOST=$(uname -a | tr -d "\\n")',
      'FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ | tr -d "\\n")',
      `jq -n --argjson slice 1.2 --rawfile spec /workspace/run/SPEC.txt --arg gitUrl '${sq(gitUrl)}' --arg clone "$CLONE" --arg head "$HEAD" --arg host "$HOST" --arg finishedAt "$FINISHED" --arg execStatus "$EXEC_STATUS" --arg execEc "$EXEC_EC" --rawfile execOut /workspace/run/EXEC_STDOUT.txt --rawfile execErr /workspace/run/EXEC_STDERR.txt '{slice:$slice, spec:(if $spec=="" then null else $spec end), gitUrl:$gitUrl, clone:$clone, head:(if $head=="" then null else $head end), host:$host, finishedAt:$finishedAt, execute:{status:$execStatus, exitCode:(if $execEc=="" then null else ($execEc|tonumber) end), stdout:$execOut, stderr:$execErr}}' > /workspace/run/RESULT.json`,
      "cat /workspace/run/RESULT.json",
      'if [ "$CLONE" != "ok" ]; then exit 1; fi',
      'if [ "$EXEC_STATUS" = "failed" ] || [ "$EXEC_STATUS" = "timeout" ]; then exit 1; fi',
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
