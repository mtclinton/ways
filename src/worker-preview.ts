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

/** Fail if text mentions a banned script name (not the allowed ways-p-* name). */
export function assertDeployOutputSafe(
  output: string,
  allowedName: string,
): void {
  if (output.includes("do-not-use-this-name")) {
    throw new Error(
      "wrangler output contains banned name: do-not-use-this-name",
    );
  }
  const scrubbed = output.split(allowedName).join("__ALLOWED__");
  if (/(?:^|[^a-z0-9_-])ways(?:[^a-z0-9_-]|$)/i.test(scrubbed)) {
    throw new Error("wrangler output contains banned name: ways");
  }
}

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

/** Strip line and block comments enough to JSON.parse wrangler.jsonc. */
export function parseWranglerJsonc(raw: string): {
  main?: string;
  compatibility_date?: string;
  name?: string;
} {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped) as {
    main?: string;
    compatibility_date?: string;
    name?: string;
  };
}

export type WorkerPreview =
  | { status: "ready"; name: string; url: string; createdAt: string }
  | {
      status: "expired";
      name?: string;
      url?: string;
      createdAt?: string;
    }
  | { status: "failed"; name?: string; error: string }
  | { status: "skipped"; reason: "no-wrangler-config" };

export async function deployWorkerModuleViaApi(opts: {
  accountId: string;
  token: string;
  name: string;
  mainModule: string;
  moduleSource: string;
  compatibilityDate: string;
  workersDevSubdomain: string;
}): Promise<{ url: string; apiBody: string }> {
  const name = assertSafePreviewWorkerName(opts.name);
  const form = new FormData();
  const metadata = {
    main_module: opts.mainModule,
    compatibility_date: opts.compatibilityDate,
  };
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  form.append(
    opts.mainModule,
    new Blob([opts.moduleSource], {
      type: "application/javascript+module",
    }),
  );

  const putUrl = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/scripts/${name}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  });
  const putText = await putRes.text();
  let putJson: { success?: boolean; errors?: unknown };
  try {
    putJson = JSON.parse(putText) as { success?: boolean; errors?: unknown };
  } catch {
    throw new Error(`script upload non-JSON (${putRes.status}): ${putText.slice(0, 500)}`);
  }
  if (!putRes.ok || !putJson.success) {
    throw new Error(
      `script upload failed: ${JSON.stringify(putJson.errors ?? putText).slice(0, 1500)}`,
    );
  }
  assertDeployOutputSafe(putText, name);

  const subRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/scripts/${name}/subdomain`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    },
  );
  const subText = await subRes.text();
  assertDeployOutputSafe(subText, name);
  // subdomain enable may 409 if already on — ignore non-fatal
  if (!subRes.ok && subRes.status !== 409) {
    let detail = subText;
    try {
      detail = JSON.stringify(
        (JSON.parse(subText) as { errors?: unknown }).errors ?? subText,
      );
    } catch {
      /* keep */
    }
    throw new Error(`enable workers.dev failed: ${detail.slice(0, 800)}`);
  }

  const url = `https://${name}.${opts.workersDevSubdomain}.workers.dev`;
  return { url, apiBody: putText };
}

export const PREVIEW_TTL_MS = 60 * 60 * 1000;

const DELETABLE_PREVIEW_NAME = /^ways-p-[0-9a-f]{8}$/;

export function isDeletablePreviewWorkerName(name: string): boolean {
  return DELETABLE_PREVIEW_NAME.test(name);
}

export function assertDeletablePreviewWorkerName(name: string): string {
  if (
    name === "ways" ||
    name === "do-not-use-this-name" ||
    !isDeletablePreviewWorkerName(name)
  ) {
    throw new Error(`not a deletable preview worker name: ${name}`);
  }
  return name;
}

export async function deleteWorkerScriptViaApi(opts: {
  accountId: string;
  token: string;
  name: string;
}): Promise<{ ok: true; apiBody: string }> {
  const name = assertDeletablePreviewWorkerName(opts.name);
  const delUrl = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/scripts/${name}`;
  const delRes = await fetch(delUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  const delText = await delRes.text();
  let delJson: { success?: boolean; errors?: unknown };
  try {
    delJson = JSON.parse(delText) as { success?: boolean; errors?: unknown };
  } catch {
    throw new Error(
      `script delete non-JSON (${delRes.status}): ${delText.slice(0, 500)}`,
    );
  }
  if (!delRes.ok || !delJson.success) {
    throw new Error(
      `script delete failed: ${JSON.stringify(delJson.errors ?? delText).slice(0, 1500)}`,
    );
  }
  return { ok: true, apiBody: delText };
}
