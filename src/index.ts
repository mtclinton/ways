import { getAgentByName } from "agents";
import { ContractError, parseCreateRun, type Phase } from "./run";
import { RunAgent } from "./run-agent";
import {
  listRunIndexRemote,
  upsertRunIndexRemote,
  type RunIndexEntry,
} from "./run-index";

export { RunAgent, Sandbox } from "./run-agent";
export { RunIndex } from "./run-index-do";

type Env = {
  RunAgent: DurableObjectNamespace<RunAgent>;
  RunIndex: DurableObjectNamespace;
  ASSETS: Fetcher;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/runs") {
        const runs = await listRunIndexRemote(env);
        return json({ runs }, 200);
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const input = parseCreateRun(await request.json());
        const id = crypto.randomUUID();
        const agent = await getAgentByName(env.RunAgent, id);
        const start = new Request(new URL("/start", request.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            spec: input.spec,
            gitUrl: input.gitUrl,
          }),
        });
        const res = await agent.fetch(start);
        const body = (await res.clone().json()) as {
          id: string;
          phase: Phase;
          createdAt: string;
          spec: string | null;
          gitUrl: string | null;
        };
        if (res.ok || res.status === 202) {
          const entry: RunIndexEntry = {
            id: body.id ?? id,
            phase: body.phase ?? "queued",
            createdAt: body.createdAt ?? new Date().toISOString(),
            spec: body.spec ?? input.spec,
            gitUrl: body.gitUrl ?? input.gitUrl,
          };
          await upsertRunIndexRemote(env, entry);
        }
        return res;
      }

      const match = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && match?.[1]) {
        const agent = await getAgentByName(env.RunAgent, match[1]);
        return agent.fetch(new Request(new URL("/", request.url)));
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "not found" }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof ContractError) {
        return json({ error: err.message, slice: 1 }, err.status);
      }
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}
