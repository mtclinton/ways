# Working in this repo

This is **ways**, an agent shipyard on Cloudflare. Working title only.

## Slice rule

Implement the current slice in `CONTRACT.md`. Do not add the next slice in the same PR.

Current slice: **1** — accept a spec, run a sandbox job, persist a trace on a Durable Object.

## Layout

- `src/run.ts` — contract types and the state machine. Pure. Tests live here first.
- `src/run-agent.ts` — Agents SDK Durable Object that owns one run.
- `src/index.ts` — HTTP surface only.
- `src/sandbox-job.ts` — the exact shell the sandbox executes.
- `public/` — operator UI. Not the product.

## Hard rules

- One write path: only `RunAgent` starts a sandbox or creates an Artifacts repo.
- Do not log Artifacts tokens.
- Do not bind products we are not using yet.
- Never edit old Wrangler migrations. Add a new tag.
- `npm run check` must pass before a PR is claimed done.

## Next slices (do not implement until asked)

1.1 Clone `gitUrl` into the sandbox.
2 AI Search over a runbook bucket.
3 Flagship on a preview Worker.
4 `wrangler deploy --temporary`.
5 WriteGuard + wallet cap.
