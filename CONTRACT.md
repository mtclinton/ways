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

# Slice 1.4 contract

Static HTML preview from the same sandbox. Do **not** `wrangler deploy` customer repos.

After `clone === "ok"`:

1. If `/workspace/run/src/public/index.html` exists → `preview = { status: "ready", path: "public/index.html" }`
2. Else if `/workspace/run/src/index.html` exists → `preview = { status: "ready", path: "index.html" }`
3. Else → `preview = { status: "skipped", reason: "no-static-index" }`
4. `GET /api/runs/:id/preview`
   - **200** `text/html` serving that file via sandbox `readFile` (same sandbox as the run)
   - **409** if run is not terminal or `clone` is not `ok`
   - **404** if preview was skipped
5. Path traversal banned: only `public/index.html` and `index.html`
6. No Artifacts / Flagship / wallets / Temporary Accounts

# Slice 1.4.1 contract

Persist static preview HTML so GET /preview works after sandbox.destroy (Keel demo 2026-09-14).

Builds on Slice 1.4. Allowlist unchanged (`public/index.html`, `index.html`).

1. When preview is ready (`public/index.html` or `index.html`), read the allowlisted file **once during the run** (via sandbox `readFile`) **before** `sandbox.destroy()`.
2. Cap **256KB** (UTF-8 bytes). If larger → do **not** store; set `preview = { status: "skipped", reason: "too-large" }` in RESULT.
3. Store the HTML on the RunAgent Durable Object (`previewHtml` in DO storage preferred so Agent state broadcasts stay small).
4. `GET /api/runs/:id/preview` serves that **stored** HTML as **200** `text/html`. Do **not** depend on a live sandbox.
5. If no stored HTML → **404** preview skipped (same shape as Slice 1.4 skipped).
6. **409** still applies if run is not terminal or `clone` is not `ok`.
7. Static path allowlist / traversal ban unchanged. No Artifacts / Flagship / wallets.

# Slice 1.5 contract

Preview-deploy a cloned Worker under a **forced** name. Never use the name in the clone’s wrangler config.

After `clone === "ok"`:

1. If neither `wrangler.jsonc` nor `wrangler.toml` exists at the clone root → `workerPreview = { status: "skipped", reason: "no-wrangler-config" }`
2. Else deploy with forced script name `ways-p-<first8 of run id>` (lowercase hex from the UUID prefix).
3. Never deploy script name `ways` or `do-not-use-this-name`. Rewrite the clone config name before deploy; pass `--name` as well.
4. On success: `workerPreview = { status: "ready", name, url }` where `url` is the workers.dev URL wrangler printed.
5. On deploy failure: `workerPreview = { status: "failed", error }`
6. Static `/preview` from Slice 1.4 unchanged. No Artifacts / Flagship / wallets.


# Slice 1.6 contract

Preview Worker TTL and explicit delete. Builds on Slice 1.5.

1. When `workerPreview.status === "ready"`, it also stores `createdAt` (ISO timestamp).
2. After a successful Slice 1.5 deploy, schedule deletion of that preview script **1 hour** later (Durable Object Alarm on the RunAgent, via Agent `schedule` / `setAlarm`).
3. `DELETE /api/runs/:id/preview` immediately deletes that run’s `ways-p-<8>` script only.
   - **404** if there is no ready worker preview
   - Never delete script `ways`
   - Never delete names that do not match `^ways-p-[0-9a-f]{8}$`
4. After delete (alarm or DELETE): `workerPreview.status = "expired"` (keep `name` / `url` / `createdAt`). GET `workerPreview.url` after delete should 404 (or Cloudflare error 1000+).
5. Static `/preview` from Slice 1.4 unchanged: `GET` still serves HTML; `DELETE` is for the worker preview script only.
6. No Artifacts / Flagship / wallets. Scripts API only (no wrangler-in-sandbox).

# Slice 1.7 contract

Optional `gitRef` on create — clone a specific branch, tag, or commit.

1. `POST /api/runs` may include `gitRef`: branch name like `main`, 40-hex sha, or tag-like token matching `^[A-Za-z0-9._/-]{1,200}$`.
2. Reject refs with `..`, leading `-`, or spaces (and empty). Return **422** via existing `ContractError` path.
3. When `gitRef` is set: clone with `git clone --depth 1 --branch <ref>` into `/workspace/run/src`; if that fails (e.g. sha), fall back to clone default then `git fetch --depth 1 origin <ref> && git checkout <ref>` (or `FETCH_HEAD`).
4. `RESULT.json` includes `gitRef` (string or null) and `head` must be the checked-out commit.
5. When `gitRef` omitted: unchanged default-branch shallow clone; `gitRef` null in RESULT.
6. Still no Artifacts / Flagship / wallets. Scripts API only for previews.

# Slice 1.7.1 contract

Operator UI: optional `gitRef` input. POST `{ spec, gitUrl, gitRef }` omitting empty fields.

# Slice 1.8 contract

Private GitHub HTTPS clone via optional `GITHUB_TOKEN` Worker secret.

1. Public https `gitUrl` still clones with no token (anonymous).
2. If anonymous clone fails with auth and `GITHUB_TOKEN` is set and the URL host is `github.com`, retry clone using authenticated https (`git -c http.extraHeader="Authorization: Bearer $GITHUB_TOKEN"`). Do **not** persist a tokenized URL.
3. `RESULT.gitUrl` stays the original https URL with **no userinfo** (no `x-access-token`, no embedded token).
4. Clone fail → `phase === "failed"` (existing Slice 1.2.1 rule).
5. If no token and the repo is private → clone failed (expected).
6. Token is passed into the sandbox only via `sandbox.exec(..., { env: { GITHUB_TOKEN } })`, never embedded in the job command string or RESULT/gitUrl fields.
7. Still no Artifacts / Flagship / wallets required for this slice.

# Slice 1.9 contract

Desk polish — operator README and UI for previews. Builds on 1.4–1.8; no new runtime products.

1. `README.md` is the **operator** doc: what a run is (`spec` + optional `gitUrl` + optional `gitRef`), what it will not do (no prod deploy of `ways`, no wrangler-in-sandbox, no tokens in `gitUrl`), public vs private GitHub (`GITHUB_TOKEN`; clean `RESULT.gitUrl`), preview kinds (static GET + worker `ways-p-<8>` + DELETE expire), and fixture links.
2. Operator UI on a loaded run:
   - `preview.status === "ready"` → link **Static preview** → `GET /api/runs/:id/preview`
   - `workerPreview.status === "ready"` → link **Worker preview** → `workerPreview.url` and button **Expire preview** → `DELETE /api/runs/:id/preview` then refresh
   - `workerPreview.status === "expired"` → show expired (no Expire button)
3. Recent-runs list, start form, and `gitRef` field unchanged. Handlers from 1.4–1.6 unchanged.
