import type { Phase } from "./run";

export const RUN_INDEX_CAP = 50;
export const RUN_INDEX_NAME = "ways";

export type RunIndexEntry = {
  id: string;
  phase: Phase;
  createdAt: string;
  spec?: string | null;
  gitUrl?: string | null;
  execute?: unknown;
};

/** Insert or replace by id; newest createdAt first; cap length. */
export function upsertRunIndex(
  entries: RunIndexEntry[],
  next: RunIndexEntry,
  cap = RUN_INDEX_CAP,
): RunIndexEntry[] {
  const rest = entries.filter((e) => e.id !== next.id);
  const merged = [next, ...rest];
  merged.sort((a, b) => {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return b.id.localeCompare(a.id);
  });
  return merged.slice(0, cap);
}

export function listRunIndex(entries: RunIndexEntry[]): RunIndexEntry[] {
  return [...entries].sort((a, b) => {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return b.id.localeCompare(a.id);
  });
}

export function getRunIndexStub(env: {
  RunIndex: DurableObjectNamespace;
}): DurableObjectStub {
  return env.RunIndex.get(env.RunIndex.idFromName(RUN_INDEX_NAME));
}

export async function upsertRunIndexRemote(
  env: { RunIndex: DurableObjectNamespace },
  entry: RunIndexEntry,
): Promise<void> {
  const stub = getRunIndexStub(env);
  const res = await stub.fetch(
    new Request("https://run-index/upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }),
  );
  if (!res.ok) {
    console.warn("run-index upsert failed", res.status, await res.text());
  }
}

export async function listRunIndexRemote(env: {
  RunIndex: DurableObjectNamespace;
}): Promise<RunIndexEntry[]> {
  const stub = getRunIndexStub(env);
  const res = await stub.fetch(new Request("https://run-index/list"));
  if (!res.ok) {
    throw new Error(`run-index list failed: ${res.status}`);
  }
  const body = (await res.json()) as { runs: RunIndexEntry[] };
  return body.runs ?? [];
}
