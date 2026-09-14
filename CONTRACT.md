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
   - Non-zero exit or timeout → `execute.status` is `failed`|`timeout`; see Slice 1.2.1 for phase.
   - If no `package.json`: skip execute, `execute.status === "skipped"`.
3. `RESULT.json` adds `execute`:
   - `status`: `"ok"` | `"failed"` | `"skipped"` | `"timeout"`
   - `exitCode`: number or `null`
   - `stdout` / `stderr`: each truncated to 8KB
4. Spec-only runs stay Slice 1 (no `execute` block required).
5. Still no Artifacts, Flagship, wallets, or planner LLM.

# Slice 1.2.1 contract

Clarifies phase vs execute for gitUrl runs (Keel dogfood 2026-09-13).

1. If `gitUrl` present and `clone` fails → `phase === "failed"`.
2. If `clone === "ok"` and `execute.status` is `ok` | `failed` | `timeout` | `skipped` → `phase === "done"`.
   `execute.status` stays accurate; a timed-out npm must not hide a good clone.
3. Spec-only (Slice 1) unchanged: sandbox script failure still fails the run.
4. `GET /api/runs/:id` may include `result.json` — parsed `RESULT.json` from `result.stdout` when stdout is JSON — so clients need not scrape.
5. Execute stdout/stderr remain capped at 8KB; install/test timeouts remain 60s.

# Slice 1.2.2 contract

Skip execute when a lite sandbox cannot finish install. Do not burn 60s writing empty timeout logs.

After `clone === "ok"`:

1. No `package.json` → `execute.status = "skipped"`, `reason = "no-package-json"`.
2. If `package.json` lists `wrangler`, `next`, `vite`, `webpack`, or `@cloudflare/vite-plugin` in `dependencies` or `devDependencies` → do **not** `npm install`. `execute.status = "skipped"`, `reason = "heavy-install"`.
3. Else: `npm install --omit=dev --no-audit --no-fund` with **30s** timeout.
   - timeout → `skipped` / `install-timeout` (no `npm test`)
   - non-zero → `skipped` / `install-failed` (no `npm test`)
4. Only if install exit 0: `npm test` with **30s** timeout → `ok` | `failed` | `timeout` as before.
5. Phase rule from 1.2.1 unchanged: `clone === "ok"` ⇒ `phase === "done"`.
6. `RESULT.json` `execute` may include optional `reason` when skipped.
7. `spec` is never executed as shell.

# Slice 1.3 contract

Run index — operators can list recent runs without already knowing an id.

1. `GET /api/runs` returns `{ "runs": [ { id, phase, createdAt, spec?, gitUrl?, execute? } ] }` newest first (by `createdAt`).
2. Cap **50** entries. Do not scan all run Durable Objects; use a dedicated index store.
3. A new `POST /api/runs` must appear in the list after it is accepted.
4. Index updates again when a run reaches a terminal phase (`done` | `failed`), including `execute` when present.
5. `GET /api/runs/:id` unchanged (full run state).
