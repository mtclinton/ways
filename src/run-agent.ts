import { Agent } from "agents";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import {
  isTerminal,
  newRun,
  transition,
  type RunState,
} from "./run";
import { sandboxCommand } from "./sandbox-job";

export { Sandbox };

type WaysEnv = {
  RunAgent: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;
  ARTIFACTS: {
    create: (
      name: string,
      opts?: { description?: string; setDefaultBranch?: string },
    ) => Promise<{ name: string; remote: string; token?: string }>;
  };
};

export class RunAgent extends Agent<WaysEnv, RunState> {
  override initialState: RunState = newRun("pending", "", new Date(0).toISOString());

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json(this.publicState());
    }

    if (request.method === "POST" && url.pathname === "/start") {
      if (this.state.id !== "pending" && this.state.phase !== "queued") {
        return Response.json(this.publicState(), { status: 409 });
      }
      const body = (await request.json()) as { id: string; spec: string };
      const now = new Date().toISOString();
      this.setState(newRun(body.id, body.spec, now));
      this.ctx.waitUntil(this.execute());
      return Response.json(this.publicState(), { status: 202 });
    }

    return new Response("not found", { status: 404 });
  }

  private publicState(): RunState {
    return this.state;
  }

  private async execute(): Promise<void> {
    const id = this.state.id;
    try {
      this.setState(
        transition(this.state, "preparing", now(), "opening workspace"),
      );

      const artifact = await this.openArtifact(id);
      if (artifact) {
        this.setState(
          transition(this.state, "running", now(), "sandbox started", {
            artifact,
            data: { remote: artifact.remote },
          }),
        );
      } else {
        this.setState(
          transition(this.state, "running", now(), "sandbox started (no artifacts namespace yet)"),
        );
      }

      const sandbox = getSandbox(this.env.Sandbox, id);
      const exec = await sandbox.exec(sandboxCommand(this.state.spec));

      const result = {
        stdout: exec.stdout ?? "",
        stderr: exec.stderr ?? "",
        exitCode: exec.exitCode ?? (exec.success ? 0 : 1),
      };

      if (result.exitCode !== 0) {
        this.setState(
          transition(this.state, "failed", now(), "sandbox exited non-zero", {
            result,
            error: result.stderr || `exit ${result.exitCode}`,
          }),
        );
        return;
      }

      this.setState(
        transition(this.state, "done", now(), "result written", { result }),
      );
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
    }
  }

  private async openArtifact(id: string) {
    try {
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
