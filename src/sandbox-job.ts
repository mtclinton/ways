/** Shell the sandbox runs. Keep it boring and deterministic. */
export function slice1Script(spec: string): string {
  const escaped = spec.replace(/'/g, `'\\''`);
  return [
    "set -eu",
    "mkdir -p /workspace/run",
    `printf '%s' '${escaped}' > /workspace/run/SPEC.txt`,
    "uname -a > /workspace/run/HOST.txt",
    "date -u +%Y-%m-%dT%H:%M:%SZ > /workspace/run/FINISHED_AT.txt",
    "jq -n --rawfile spec /workspace/run/SPEC.txt --rawfile host /workspace/run/HOST.txt --rawfile finished /workspace/run/FINISHED_AT.txt '{slice:1, spec:$spec, host:$host, finishedAt:$finished}' > /workspace/run/RESULT.json",
    "cat /workspace/run/RESULT.json",
  ].join("\n");
}

export function sandboxCommand(spec: string): string {
  return `bash -lc ${JSON.stringify(slice1Script(spec))}`;
}
