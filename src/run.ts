export const SLICE = 1 as const;

export type Phase = "queued" | "preparing" | "running" | "done" | "failed";

export type RunEvent = {
  at: string;
  phase: Phase;
  message: string;
  data?: Record<string, unknown>;
};

export type ArtifactPointer = {
  name: string;
  remote: string;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunState = {
  id: string;
  slice: typeof SLICE;
  spec: string;
  phase: Phase;
  events: RunEvent[];
  createdAt: string;
  updatedAt: string;
  artifact?: ArtifactPointer;
  result?: ExecResult;
  error?: string;
};

export type CreateRunInput = {
  spec: string;
};

export class ContractError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ContractError";
  }
}

const MAX_SPEC_BYTES = 8 * 1024;

export function parseCreateRun(body: unknown): CreateRunInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ContractError(400, "body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  if ("gitUrl" in rec) {
    throw new ContractError(
      422,
      "Slice 1 accepts spec.text only. gitUrl lands in slice 1.1.",
    );
  }
  const spec = rec.spec;
  if (typeof spec !== "string") {
    throw new ContractError(400, "spec must be a string");
  }
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new ContractError(400, "spec must be non-empty");
  }
  if (new TextEncoder().encode(trimmed).length > MAX_SPEC_BYTES) {
    throw new ContractError(413, `spec exceeds ${MAX_SPEC_BYTES} bytes`);
  }
  return { spec: trimmed };
}

export function newRun(id: string, spec: string, now: string): RunState {
  return {
    id,
    slice: SLICE,
    spec,
    phase: "queued",
    events: [
      {
        at: now,
        phase: "queued",
        message: "run accepted",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function transition(
  state: RunState,
  next: Phase,
  now: string,
  message: string,
  extra?: {
    data?: Record<string, unknown>;
    artifact?: ArtifactPointer;
    result?: ExecResult;
    error?: string;
  },
): RunState {
  assertTransition(state.phase, next);
  const event: RunEvent = {
    at: now,
    phase: next,
    message,
  };
  if (extra?.data) event.data = extra.data;
  return {
    ...state,
    phase: next,
    updatedAt: now,
    events: [...state.events, event],
    ...(extra?.artifact ? { artifact: extra.artifact } : {}),
    ...(extra?.result ? { result: extra.result } : {}),
    ...(extra?.error ? { error: extra.error } : {}),
  };
}

const ALLOWED: Record<Phase, readonly Phase[]> = {
  queued: ["preparing", "failed"],
  preparing: ["running", "failed"],
  running: ["done", "failed"],
  done: [],
  failed: [],
};

function assertTransition(from: Phase, to: Phase): void {
  if (!ALLOWED[from].includes(to)) {
    throw new ContractError(409, `illegal transition ${from} → ${to}`);
  }
}

export function isTerminal(phase: Phase): boolean {
  return phase === "done" || phase === "failed";
}
