# Slice 1 contract

A run is done only when all of these are true.

1. `POST /api/runs` with `{ "spec": "<text>" }` returns `202` and a `queued` or later state that includes `id`.
2. `GET /api/runs/:id` returns the same run. Polling is allowed.
3. Phases move only `queued → preparing → running → done` or any of those `→ failed`. No skips.
4. A terminal run has either `result.exitCode === 0` and `phase === "done"`, or `phase === "failed"` and `error` set.
5. The sandbox writes `/workspace/run/RESULT.json` with `{ slice, spec, host, finishedAt }`. `result.stdout` contains that JSON.
6. `gitUrl` is rejected with `422`. Temporary Accounts, Flagship, Wallets, Mesh, Voice, Email are out of slice.

Out of contract: pretty UI, LLM planning, cloning a customer repo, deploying a preview Worker.
