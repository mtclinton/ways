import { Agent } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import {
  isTerminal,
  newRun,
  terminalPhaseForSandbox,
  transition,
  withParsedResultJson,
  type CreateRunInput,
  type RunState,
} from "./run";
import { sandboxCommand } from "./sandbox-job";
import { upsertRunIndexRemote } from "./run-index";

export { Sandbox };

type WaysEnv = {
  RunAgent: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;
  RunIndex: DurableObjectNamespace;
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

      const result = withParsedResultJson({
        stdout: exec.stdout ?? "",
        stderr: exec.stderr ?? "",
        exitCode: exec.exitCode ?? (exec.success ? 0 : 1),
      });

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
