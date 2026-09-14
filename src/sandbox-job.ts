/** Shell the sandbox runs. Keep it boring and deterministic. */

export type SandboxJobInput = {
  spec: string | null;
  gitUrl: string | null;
};

function sq(value: string): string {
  return value.replace(/'/g, `'\\''`);
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
      "set +e",
      `timeout 30 git clone --depth 1 --single-branch '${sq(gitUrl)}' /workspace/run/src > /workspace/run/CLONE_STDERR.txt 2>&1`,
      "CLONE_EC=$?",
      "set -e",
      'if [ "$CLONE_EC" -eq 0 ]; then CLONE=ok; HEAD=$(git -C /workspace/run/src rev-parse HEAD | tr -d "\\n"); else cat /workspace/run/CLONE_STDERR.txt >&2 || true; fi',
      'HOST=$(uname -a | tr -d "\\n")',
      'FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ | tr -d "\\n")',
      // jq --arg / --rawfile so outer quoting never expands jq vars incorrectly;
      // values with $ in spec are in SPEC.txt via printf.
      `jq -n --argjson slice 1.1 --rawfile spec /workspace/run/SPEC.txt --arg gitUrl '${sq(gitUrl)}' --arg clone "$CLONE" --arg head "$HEAD" --arg host "$HOST" --arg finishedAt "$FINISHED" '{slice:$slice, spec:(if $spec=="" then null else $spec end), gitUrl:$gitUrl, clone:$clone, head:(if $head=="" then null else $head end), host:$host, finishedAt:$finishedAt}' > /workspace/run/RESULT.json`,
      "cat /workspace/run/RESULT.json",
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
