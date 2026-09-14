import { DurableObject } from "cloudflare:workers";
import {
  listRunIndex,
  upsertRunIndex,
  type RunIndexEntry,
} from "./run-index";

type IndexState = { runs: RunIndexEntry[] };

/** Singleton Durable Object holding the recent-run index (no DO scan). */
export class RunIndex extends DurableObject {
  private async load(): Promise<RunIndexEntry[]> {
    const state = (await this.ctx.storage.get<IndexState>("index")) ?? {
      runs: [],
    };
    return state.runs ?? [];
  }

  private async save(runs: RunIndexEntry[]): Promise<void> {
    await this.ctx.storage.put("index", { runs } satisfies IndexState);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/list") {
      const runs = listRunIndex(await this.load());
      return Response.json({ runs });
    }

    if (request.method === "POST" && url.pathname === "/upsert") {
      const body = (await request.json()) as RunIndexEntry;
      if (!body?.id || !body.phase || !body.createdAt) {
        return Response.json({ error: "invalid entry" }, { status: 400 });
      }
      const entry: RunIndexEntry = {
        id: body.id,
        phase: body.phase,
        createdAt: body.createdAt,
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
        ...(body.gitUrl !== undefined ? { gitUrl: body.gitUrl } : {}),
        ...(body.execute !== undefined ? { execute: body.execute } : {}),
      };
      const runs = upsertRunIndex(await this.load(), entry);
      await this.save(runs);
      return Response.json({ ok: true, runs });
    }

    return new Response("not found", { status: 404 });
  }
}
