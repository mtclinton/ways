# ways

Working title for an agent shipyard on Cloudflare. The public name is still open (`slipway` is taken).

Slice 1 is intentionally small: **one spec → one sandbox → one trace**. That is the path we will keep extending.

## What you just got

- `POST /api/runs` / `GET /api/runs/:id` with a typed state machine
- A `RunAgent` Durable Object (Agents SDK) per run
- A Cloudflare Sandbox that writes `/workspace/run/RESULT.json`
- Optional Artifacts repo `run-<id>` (run still succeeds if the namespace is missing)
- A one-page operator UI
- Contract tests for the state machine

## Fast path on your machine

Needs Node 20+, a Cloudflare account, and Wrangler login.

```bash
cd ways
npm install
npx wrangler login
npx wrangler types
npm run check
npm run dev
```

Open the printed localhost URL. Submit a spec. You should see phases `queued → preparing → running → done` and a `RESULT.json` blob.

First deploy:

```bash
npx wrangler deploy
```

If Artifacts complains about namespace `ways`, create it once (name must match `wrangler.jsonc`):

```bash
npx wrangler artifacts namespace create ways
```

(If that subcommand has shifted in your Wrangler, use the dashboard: Workers → Artifacts → namespace `ways`.)

## Quality bar

`CONTRACT.md` is the gate. If a change does not make that document truer, it is the next slice.

## Not in this repo yet

Grok Bots, Mesh, Wallets, Flagship, Email, Voice, Temporary Accounts. Factory tools stay outside the runtime.
