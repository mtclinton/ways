# Slice 1 contract

A run is done only when all of these are true.

1. `POST /api/runs` with `{ "spec": "<text>" }` returns `202` and a `queued` or later state that includes `id`.
2. `GET /api/runs/:id` returns the same run. Polling is allowed.
3. Phases move only `queued → preparing → running → done` or any of those `→ failed`. No skips.
4. A terminal run has either `result.exitCode === 0` and `phase === "done"`, or `phase === "failed"` and `error` set.
5. The sandbox writes `/workspace/run/RESULT.json` with `{ slice, spec, host, finishedAt }`. `result.stdout` contains that JSON. Trailing newlines are stripped from `host` and `finishedAt`.
6. Temporary Accounts, Flagship, Wallets, Mesh, Voice, Email are out of slice.

Out of contract for Slice 1: pretty UI, LLM planning, cloning a customer repo, deploying a preview Worker.

# Slice 1.1 contract

Slice 1 still holds for `spec`-only runs. Slice 1.1 adds optional `gitUrl`.

1. `POST /api/runs` accepts:
   - `{ "spec": "..." }` (Slice 1)
   - `{ "gitUrl": "https://..." }`
   - `{ "spec": "...", "gitUrl": "https://..." }`
2. At least one of `spec` / `gitUrl` is required.
3. `gitUrl` must be `https` with host+path only. Reject `ssh`, `file`, `git://`, and credentials-in-URL (`userinfo`). Max 2KB.
4. When `gitUrl` is present, the sandbox:
   - `mkdir -p /workspace/run`
   - `git clone --depth 1 --single-branch <url> /workspace/run/src` with a ~30s hard timeout
   - records `HEAD` via `git -C /workspace/run/src rev-parse HEAD` on success
5. `RESULT.json` fields: `{ slice: 1.1, spec, gitUrl, clone, head, host, finishedAt }` where `spec`/`gitUrl`/`head` may be `null`, `clone` is `"ok"`|`"failed"`, and `host`/`finishedAt` have no trailing newlines.
6. If clone fails: `phase === "failed"`, stderr included, RESULT still written when possible.
7. No Artifacts binding required. No Flagship, wallets, or planner LLM.

# Slice 1.2 contract

Builds on Slice 1.1. After a successful clone, optionally run the repo's own tests.
`spec` remains a label/note — never executed as shell.

1. When `gitUrl` is present, run state `slice` is `1.2`.
2. After `clone === "ok"`:
   - If `/workspace/run/src/package.json` exists: `npm install --omit=dev` (60s timeout) then `npm test` (60s timeout) in that tree.
   - Non-zero exit or timeout → `phase === "failed"` (clone may still be `"ok"`).
   - If no `package.json`: skip execute, `phase === "done"`, `execute.status === "skipped"`.
3. `RESULT.json` adds `execute`:
   - `status`: `"ok"` | `"failed"` | `"skipped"` | `"timeout"`
   - `exitCode`: number or `null`
   - `stdout` / `stderr`: each truncated to 8KB
4. Spec-only runs stay Slice 1 (no `execute` block required).
5. Still no Artifacts, Flagship, wallets, or planner LLM.
