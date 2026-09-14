export const BANNED_WORKER_NAMES = ["ways", "do-not-use-this-name"] as const;

/** Forced preview script name: ways-p-<first 8 chars of run id>, lowercase. */
export function previewWorkerName(runId: string): string {
  const eight = runId.toLowerCase().slice(0, 8);
  return `ways-p-${eight}`;
}

export function assertSafePreviewWorkerName(name: string): string {
  const n = name.toLowerCase();
  if ((BANNED_WORKER_NAMES as readonly string[]).includes(n)) {
    throw new Error(`banned worker name: ${n}`);
  }
  if (!/^ways-p-[0-9a-f]{8}$/.test(n)) {
    throw new Error(`invalid preview worker name: ${n}`);
  }
  return n;
}

/** Fail if wrangler output mentions a banned script name (not the allowed ways-p-* name). */
export function assertDeployOutputSafe(
  output: string,
  allowedName: string,
): void {
  if (output.includes("do-not-use-this-name")) {
    throw new Error("wrangler output contains banned name: do-not-use-this-name");
  }
  const scrubbed = output.split(allowedName).join("__ALLOWED__");
  // bare script name "ways" (not ways-p-…)
  if (/(?:^|[^a-z0-9_-])ways(?:[^a-z0-9_-]|$)/i.test(scrubbed)) {
    throw new Error("wrangler output contains banned name: ways");
  }
}

/** Pull workers.dev URL for the forced name from wrangler deploy output. */
export function parsePreviewWorkerUrl(
  wranglerOutput: string,
  expectedName: string,
): string | null {
  const escaped = expectedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `https://${escaped}\\.[a-z0-9-]+\\.workers\\.dev`,
    "i",
  );
  const m = wranglerOutput.match(re);
  return m ? m[0] : null;
}

export type WorkerPreview =
  | { status: "ready"; name: string; url: string }
  | { status: "failed"; name?: string; error: string }
  | { status: "skipped"; reason: "no-wrangler-config" };
