export const SLICE = 1 as const;
export const SLICE_1_1 = 1.1 as const;

export type Slice = typeof SLICE | typeof SLICE_1_1;

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
  slice: Slice;
  spec: string | null;
  gitUrl: string | null;
  phase: Phase;
  events: RunEvent[];
  createdAt: string;
  updatedAt: string;
  artifact?: ArtifactPointer;
  result?: ExecResult;
  error?: string;
};

export type CreateRunInput = {
  spec: string | null;
  gitUrl: string | null;
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
const MAX_GITURL_BYTES = 2 * 1024;

export function parseCreateRun(body: unknown): CreateRunInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ContractError(400, "body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;

  let spec: string | null = null;
  if ("spec" in rec && rec.spec !== undefined && rec.spec !== null) {
    if (typeof rec.spec !== "string") {
      throw new ContractError(400, "spec must be a string");
    }
    const trimmed = rec.spec.trim();
    if (trimmed.length === 0) {
      throw new ContractError(400, "spec must be non-empty");
    }
    if (new TextEncoder().encode(trimmed).length > MAX_SPEC_BYTES) {
      throw new ContractError(413, `spec exceeds ${MAX_SPEC_BYTES} bytes`);
    }
    spec = trimmed;
  }

  let gitUrl: string | null = null;
  if ("gitUrl" in rec && rec.gitUrl !== undefined && rec.gitUrl !== null) {
    gitUrl = parseGitUrl(rec.gitUrl);
  }

  if (spec === null && gitUrl === null) {
    throw new ContractError(400, "at least one of spec or gitUrl is required");
  }

  return { spec, gitUrl };
}

export function parseGitUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ContractError(400, "gitUrl must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ContractError(400, "gitUrl must be non-empty");
  }
  if (new TextEncoder().encode(trimmed).length > MAX_GITURL_BYTES) {
    throw new ContractError(413, `gitUrl exceeds ${MAX_GITURL_BYTES} bytes`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ContractError(400, "gitUrl must be a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new ContractError(
      422,
      "gitUrl must be https (ssh/file/git:// rejected)",
    );
  }
  if (url.username || url.password) {
    throw new ContractError(422, "gitUrl must not include credentials");
  }
  if (url.search || url.hash) {
    throw new ContractError(422, "gitUrl must be host+path only");
  }
  if (!url.hostname || url.pathname === "") {
    throw new ContractError(422, "gitUrl must include host and path");
  }

  // Normalize to origin + pathname (drop trailing slash except root)
  const path =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  return `${url.origin}${path}`;
}

export function newRun(
  id: string,
  input: CreateRunInput | string,
  now: string,
): RunState {
  const parsed: CreateRunInput =
    typeof input === "string"
      ? { spec: input, gitUrl: null }
      : { spec: input.spec, gitUrl: input.gitUrl };
  const slice: Slice = parsed.gitUrl ? SLICE_1_1 : SLICE;
  return {
    id,
    slice,
    spec: parsed.spec,
    gitUrl: parsed.gitUrl,
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
