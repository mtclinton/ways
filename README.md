# ways

Operator desk for an agent shipyard on Cloudflare. One run: submit a spec (and optional git clone), get a trace.

Live: https://ways.max-977.workers.dev

## What a run is

`POST /api/runs` with:

| Field | Required | Meaning |
| --- | --- | --- |
| `spec` | at least one of spec / gitUrl | Label / note only — never executed as shell |
| `gitUrl` | optional | Public or private GitHub HTTPS URL (`https://github.com/...`) |
| `gitRef` | optional | Branch, tag, or sha to check out |

Phases: `queued → preparing → running → done` (or `→ failed`). Poll `GET /api/runs/:id`. List recent with `GET /api/runs`.

## What it will not do

- **No prod deploy of `ways`** — preview Workers are forced to `ways-p-<8 hex>` only
- **No wrangler-in-sandbox** — preview deploy uses the Scripts API from the Worker, not `wrangler` inside the sandbox
- **No tokens in `gitUrl`** — credentials-in-URL (`userinfo`) are rejected; never put a PAT in the URL

## Public vs private GitHub

- **Public** repos clone anonymously over HTTPS.
- **Private** repos need the Worker secret `GITHUB_TOKEN`. Auth is applied only for the clone (`Authorization` header / Basic `x-access-token`); it is never written into RESULT or traces.
- `RESULT.gitUrl` is always the clean https URL **with no userinfo**.

## Preview kinds

After a successful clone:

1. **Static** — if the repo has `public/index.html` or `index.html`:
   - `GET /api/runs/:id/preview` → `200` `text/html` (HTML stored on the run DO)
2. **Worker** — if the clone has `wrangler.jsonc` / `wrangler.toml`:
   - Deployed as `https://ways-p-<8>.max-977.workers.dev`
   - Auto-expires after ~1 hour
   - `DELETE /api/runs/:id/preview` → expire immediately (`workerPreview.status` becomes `expired`)

Static GET is unchanged by DELETE; DELETE only removes the preview Worker script.

## Fixtures

| Repo | Use |
| --- | --- |
| [ways-fixture](https://github.com/mtclinton/ways-fixture) | Basic clone / execute |
| [ways-worker-fixture](https://github.com/mtclinton/ways-worker-fixture) | Worker preview deploy |
| [ways-starfield](https://github.com/mtclinton/ways-starfield) | Static + visual preview |
| [ways-globe](https://github.com/mtclinton/ways-globe) | Static / demo |
| [ways-private-fixture](https://github.com/mtclinton/ways-private-fixture) | Private clone (needs `GITHUB_TOKEN`) |

## Local

```bash
npm install
npx wrangler login
npx wrangler types
npm test
npm run dev
```

`CONTRACT.md` is the gate for what each slice must keep true.
