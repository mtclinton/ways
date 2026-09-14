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
  assertSafePreviewWorkerName,
  deleteWorkerScriptViaApi,
  deployWorkerModuleViaApi,
  isDeletablePreviewWorkerName,
  parseWranglerJsonc,
  PREVIEW_TTL_MS,
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

    if (request.method === "DELETE" && url.pathname === "/preview") {
      return await this.handleDeleteWorkerPreview();
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

  /** Agent schedule callback — delete preview Worker after PREVIEW_TTL_MS. */
  async expireWorkerPreview(): Promise<void> {
    await this.expireReadyWorkerPreview("alarm");
  }

  private getWorkerPreviewFromState(): WorkerPreview | null {
    const state = this.publicState();
    const json =
      state.result?.json && typeof state.result.json === "object"
        ? (state.result.json as Record<string, unknown>)
        : null;
    if (!json || !json.workerPreview || typeof json.workerPreview !== "object") {
      return null;
    }
    return json.workerPreview as WorkerPreview;
  }

  private setWorkerPreviewOnState(workerPreview: WorkerPreview): void {
    const state = this.publicState();
    if (!state.result) {
      this.setState({
        ...state,
        result: this.withWorkerPreview(
          { stdout: "", stderr: "", exitCode: 0 },
          workerPreview,
        ),
      });
      return;
    }
    this.setState({
      ...state,
      result: this.withWorkerPreview(state.result, workerPreview),
    });
  }

  private async cancelPreviewExpireSchedules(): Promise<void> {
    try {
      const schedules = this.getSchedules({});
      for (const s of schedules) {
        if (s.callback === "expireWorkerPreview") {
          await this.cancelSchedule(s.id);
        }
      }
    } catch (err) {
      console.warn("cancelPreviewExpireSchedules failed", err);
    }
    try {
      await this.ctx.storage.deleteAlarm();
    } catch (err) {
      console.warn("deleteAlarm failed", err);
    }
  }

  private async expireReadyWorkerPreview(
    _reason: "alarm" | "delete",
  ): Promise<{ deleted: boolean; name?: string }> {
    const wp = this.getWorkerPreviewFromState();
    if (!wp || wp.status !== "ready" || !wp.name) {
      return { deleted: false };
    }
    if (!isDeletablePreviewWorkerName(wp.name)) {
      return { deleted: false, name: wp.name };
    }
    const token = this.env.CLOUDFLARE_API_TOKEN;
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
    if (token && accountId) {
      try {
        await deleteWorkerScriptViaApi({
          accountId,
          token,
          name: wp.name,
        });
      } catch (err) {
        console.warn("preview script delete failed", err);
        // Still mark expired so we do not retry forever on gone scripts.
      }
    }
    this.setWorkerPreviewOnState({
      status: "expired",
      name: wp.name,
      url: wp.url,
      createdAt: wp.createdAt,
    });
    return { deleted: true, name: wp.name };
  }

  async handleDeleteWorkerPreview(): Promise<Response> {
    const wp = this.getWorkerPreviewFromState();
    if (!wp || wp.status !== "ready" || !wp.name) {
      return Response.json(
        { error: "no ready worker preview" },
        { status: 404 },
      );
    }
    if (!isDeletablePreviewWorkerName(wp.name)) {
      return Response.json(
        { error: "worker preview name not deletable" },
        { status: 404 },
      );
    }
    const token = this.env.CLOUDFLARE_API_TOKEN;
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !accountId) {
      return Response.json(
        { error: "missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID secret" },
        { status: 500 },
      );
    }
    try {
      await deleteWorkerScriptViaApi({
        accountId,
        token,
        name: wp.name,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
    await this.cancelPreviewExpireSchedules();
    this.setWorkerPreviewOnState({
      status: "expired",
      name: wp.name,
      url: wp.url,
      createdAt: wp.createdAt,
    });
    return Response.json(
      {
        ok: true,
        workerPreview: this.getWorkerPreviewFromState(),
      },
      { status: 200 },
    );
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

    // Prefer jsonc; toml only for presence (fixture uses jsonc).
    const configPath = jsonc.exists
      ? "/workspace/run/src/wrangler.jsonc"
      : "/workspace/run/src/wrangler.toml";
    const cfgFile = await sandbox.readFile(configPath, { encoding: "utf8" });
    if (!cfgFile.success) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: `failed to read ${configPath}`,
      });
    }

    let mainRel = "src/index.js";
    let compatibilityDate = "2026-09-01";
    try {
      if (configPath.endsWith(".jsonc") || configPath.endsWith(".json")) {
        const cfg = parseWranglerJsonc(cfgFile.content);
        if (cfg.main) mainRel = cfg.main;
        if (cfg.compatibility_date) compatibilityDate = cfg.compatibility_date;
        // Never deploy cfg.name — only forced name.
      }
    } catch (err) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const mainAbs = `/workspace/run/src/${mainRel.replace(/^\.\//, "")}`;
    const mainFile = await sandbox.readFile(mainAbs, { encoding: "utf8" });
    if (!mainFile.success) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: `failed to read main module ${mainRel}`,
      });
    }

    // Module key is the basename path wrangler would use (keep nested path).
    const mainModule = mainRel.replace(/^\.\//, "");

    try {
      const deployed = await deployWorkerModuleViaApi({
        accountId,
        token,
        name,
        mainModule,
        moduleSource: mainFile.content,
        compatibilityDate,
        workersDevSubdomain: "max-977",
      });
      const createdAt = new Date().toISOString();
      // Agent schedule API → DO setAlarm; callback expireWorkerPreview runs in Agent.alarm.
      await this.schedule(
        PREVIEW_TTL_MS / 1000,
        "expireWorkerPreview" as keyof this,
      );
      // Contract: also setAlarm for 1h (Agent._scheduleNextAlarm already did; reinforce).
      await this.ctx.storage.setAlarm(Date.now() + PREVIEW_TTL_MS);
      return this.withWorkerPreview(result, {
        status: "ready",
        name,
        url: deployed.url,
        createdAt,
      });
    } catch (err) {
      return this.withWorkerPreview(result, {
        status: "failed",
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      let result: ExecResult;
      try {
        const exec = await sandbox.exec(
          sandboxCommand({
            spec: this.state.spec,
            gitUrl: this.state.gitUrl,
          }),
          { timeout: 90_000 },
        );

        result = withParsedResultJson({
          stdout: exec.stdout ?? "",
          stderr: exec.stderr ?? "",
          exitCode: exec.exitCode ?? (exec.success ? 0 : 1),
        });

        // Slice 1.5: forced-name worker preview via Scripts API (never clone name)
        result = await this.maybeDeployWorkerPreview(sandbox, result);
      } finally {
        try {
          await sandbox.destroy();
        } catch (err) {
          console.warn("sandbox.destroy failed", err);
        }
      }

      const phase = terminalPhaseForSandbox(this.state.gitUrl, result!);
      if (phase === "failed") {
        this.setState(
          transition(this.state, "failed", now(), "sandbox exited non-zero", {
            result: result!,
            error: result!.stderr || `exit ${result!.exitCode}`,
          }),
        );
        await this.publishIndex();
        return;
      }

      this.setState(
        transition(this.state, "done", now(), "result written", {
          result: result!,
        }),
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
