import { Agent } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import {
  isTerminal,
  newRun,
  terminalPhaseForSandbox,
  transition,
  withParsedResultJson,
  type CreateRunInput,
  type ExecResult,
  type RunState,
} from "./run";
import { sandboxCommand } from "./sandbox-job";
import { upsertRunIndexRemote } from "./run-index";
import { previewAbsolutePath } from "./preview";
import {
  assertDeployOutputSafe,
  assertSafePreviewWorkerName,
  parsePreviewWorkerUrl,
  previewWorkerName,
  type WorkerPreview,
} from "./worker-preview";

export { Sandbox };

type WaysEnv = {
  RunAgent: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;
  RunIndex: DurableObjectNamespace;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ARTIFACTS?: {
    create: (
      name: string,
      opts?: { description?: string; setDefaultBranch?: string },
    ) => Promise<{ name: string; remote: string; token?: string }>;
  };
};

export class RunAgent extends Agent<WaysEnv, RunState> {
  override initialState: RunState = newRun(
    "pending",
    { spec: null, gitUrl: null },
    new Date(0).toISOString(),
  );

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json(this.publicState());
    }

    if (request.method === "GET" && url.pathname === "/preview") {
      return await this.handlePreview();
    }

    if (request.method === "POST" && url.pathname === "/start") {
      if (this.state.id !== "pending" && this.state.phase !== "queued") {
        return Response.json(this.publicState(), { status: 409 });
      }
      const body = (await request.json()) as {
        id: string;
        spec: string | null;
        gitUrl?: string | null;
      };
      const input: CreateRunInput = {
        spec: body.spec ?? null,
        gitUrl: body.gitUrl ?? null,
      };
      if (input.spec === "") input.spec = null;
      const now = new Date().toISOString();
      this.setState(newRun(body.id, input, now));
      this.ctx.waitUntil(this.execute());
      return Response.json(this.publicState(), { status: 202 });
    }

    return new Response("not found", { status: 404 });
  }

  async handlePreview(): Promise<Response> {
    const state = this.publicState();
    if (!isTerminal(state.phase)) {
      return Response.json({ error: "run not terminal" }, { status: 409 });
    }
    const resultJson =
      state.result?.json && typeof state.result.json === "object"
        ? (state.result.json as Record<string, unknown>)
        : null;
    if (!resultJson || resultJson.clone !== "ok") {
      return Response.json({ error: "clone not ok" }, { status: 409 });
    }
    const preview = resultJson.preview as
      | { status?: string; path?: string; reason?: string }
      | undefined;
    if (!preview || preview.status !== "ready" || !preview.path) {
      return Response.json(
        {
          error: "preview skipped",
          reason: preview?.reason ?? "no-static-index",
        },
        { status: 404 },
      );
    }
    const abs = previewAbsolutePath(preview.path);
    if (!abs) {
      return Response.json({ error: "path not allowlisted" }, { status: 400 });
    }
    try {
      const sandbox = getSandbox(this.env.Sandbox, state.id);
      const file = await sandbox.readFile(abs, { encoding: "utf8" });
      if (!file.success) {
        return Response.json({ error: "read failed" }, { status: 404 });
      }
      return new Response(file.content, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  private publicState(): RunState {
    const state = this.state;
    if (state.result && state.result.json === undefined) {
      return {
        ...state,
        result: withParsedResultJson(state.result),
      };
    }
    return state;
  }

  private withWorkerPreview(
    result: ExecResult,
    workerPreview: WorkerPreview,
  ): ExecResult {
    const base =
      result.json && typeof result.json === "object" && result.json !== null
        ? { ...(result.json as Record<string, unknown>) }
        : {};
    const json = { ...base, workerPreview };
    return {
      ...result,
      json,
      stdout: JSON.stringify(json, null, 2),
    };
  }

  private async maybeDeployWorkerPreview(
    sandbox: ReturnType<typeof getSandbox>,
    result: ExecResult,
  ): Promise<ExecResult> {
    const json =
      result.json && typeof result.json === "object" && result.json !== null
        ? (result.json as Record<string, unknown>)
        : null;
    if (!json || json.clone !== "ok") return result;

    const jsonc = await sandbox.exists("/workspace/run/src/wrangler.jsonc");
    const toml = await sandbox.exists("/workspace/run/src/wrangler.toml");
    if (!jsonc.exists && !toml.exists) {
      return this.withWorkerPreview(result, {
        status: "skipped",
        reason: "no-wrangler-config",
      });
    }

    let name: string;
    try {
      name = assertSafePreviewWorkerName(previewWorkerName(this.state.id));
    } catch (err) {
      return this.withWorkerPreview(result, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const token = this.env.CLOUDFLARE_API_TOKEN;
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !accountId) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: "missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID secret",
      });
    }

    // Rewrite clone config name so banned names never appear in wrangler output.
    const rewrite = await sandbox.exec(
      `node -e ${JSON.stringify(
        `const fs=require("fs");const path=require("path");const dir="/workspace/run/src";const name=${JSON.stringify(name)};for (const f of ["wrangler.jsonc","wrangler.toml"]) {const p=path.join(dir,f);if(!fs.existsSync(p))continue;let t=fs.readFileSync(p,"utf8");t=t.replace(/"name"\\s*:\\s*"[^"]*"/,'"name": "'+name+'"');t=t.replace(/^name\\s*=\\s*["'][^"']*["']/m,'name = "'+name+'"');fs.writeFileSync(p,t);}`,
      )}`,
      { timeout: 15_000 },
    );
    if ((rewrite.exitCode ?? 1) !== 0) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: rewrite.stderr || "failed to rewrite wrangler name",
      });
    }

    const deploy = await sandbox.exec(
      `cd /workspace/run/src && npx --yes wrangler@4 deploy --name ${name}`,
      {
        timeout: 120_000,
        env: {
          CLOUDFLARE_API_TOKEN: token,
          CLOUDFLARE_ACCOUNT_ID: accountId,
        },
      },
    );
    const out = `${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`;
    try {
      assertDeployOutputSafe(out, name);
    } catch (err) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if ((deploy.exitCode ?? 1) !== 0) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: (deploy.stderr || deploy.stdout || `exit ${deploy.exitCode}`).slice(
          0,
          2000,
        ),
      });
    }
    const url = parsePreviewWorkerUrl(out, name);
    if (!url) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: "deploy succeeded but workers.dev URL not found in output",
      });
    }
    return this.withWorkerPreview(result, { status: "ready", name, url });
  }

  private async publishIndex(): Promise<void> {
    try {
      const state = this.publicState();
      const execute =
        state.result?.json &&
        typeof state.result.json === "object" &&
        state.result.json !== null &&
        "execute" in (state.result.json as object)
          ? (state.result.json as { execute?: unknown }).execute
          : undefined;
      await upsertRunIndexRemote(this.env, {
        id: state.id,
        phase: state.phase,
        createdAt: state.createdAt,
        spec: state.spec,
        gitUrl: state.gitUrl,
        ...(execute !== undefined ? { execute } : {}),
      });
    } catch (err) {
      console.warn("run-index publish failed", err);
    }
  }

  private async execute(): Promise<void> {
    try {
      this.setState(
        transition(this.state, "preparing", now(), "opening workspace"),
      );

      const artifact = await this.openArtifact(this.state.id);
      if (artifact) {
        this.setState(
          transition(this.state, "running", now(), "sandbox started", {
            artifact,
            data: { remote: artifact.remote },
          }),
        );
      } else {
        this.setState(
          transition(
            this.state,
            "running",
            now(),
            "sandbox started (no artifacts namespace yet)",
          ),
        );
      }

      const sandbox = getSandbox(this.env.Sandbox, this.state.id);
      const exec = await sandbox.exec(
        sandboxCommand({
          spec: this.state.spec,
          gitUrl: this.state.gitUrl,
        }),
      );

      let result = withParsedResultJson({
        stdout: exec.stdout ?? "",
        stderr: exec.stderr ?? "",
        exitCode: exec.exitCode ?? (exec.success ? 0 : 1),
      });

      // Slice 1.5: forced-name worker preview deploy (never clone config name)
      result = await this.maybeDeployWorkerPreview(sandbox, result);

      const phase = terminalPhaseForSandbox(this.state.gitUrl, result);
      if (phase === "failed") {
        this.setState(
          transition(this.state, "failed", now(), "sandbox exited non-zero", {
            result,
            error: result.stderr || `exit ${result.exitCode}`,
          }),
        );
        await this.publishIndex();
        return;
      }

      this.setState(
        transition(this.state, "done", now(), "result written", { result }),
      );
      await this.publishIndex();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTerminal(this.state.phase)) return;
      const phase = this.state.phase;
      const next =
        phase === "queued"
          ? "failed"
          : phase === "preparing"
            ? "failed"
            : phase === "running"
              ? "failed"
              : phase;
      if (next === this.state.phase) return;
      this.setState(
        transition(this.state, "failed", now(), "run aborted", { error: message }),
      );
      await this.publishIndex();
    }
  }

  private async openArtifact(id: string) {
    try {
      if (!this.env.ARTIFACTS) return undefined;
      const created = await this.env.ARTIFACTS.create(`run-${id}`, {
        description: `ways slice-1 run ${id}`,
        setDefaultBranch: "main",
      });
      return { name: created.name, remote: created.remote };
    } catch (err) {
      console.warn("artifacts.create failed", err);
      return undefined;
    }
  }
}

function now(): string {
  return new Date().toISOString();
}
