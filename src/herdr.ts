import { execFile } from "node:child_process";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

const AGENT_STATUSES: readonly string[] = ["idle", "working", "blocked", "done", "unknown"];

/** A failure reported by herdr, carrying its machine-readable error code. */
export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export interface CreatedWorktree {
  workspaceId: string;
  paneId: string;
  path: string;
  branch: string;
}

export interface LiveAgent {
  /** Absent for agents that were never given a name. */
  name?: string;
  paneId: string;
  kind: string;
  status: AgentStatus;
}

/** The herdr operations Drover depends on. */
export interface Herdr {
  /** Without `path`, herdr places the worktree in its configured worktree directory. */
  createWorktree(input: { repo: string; branch: string; label: string; path?: string }): Promise<CreatedWorktree>;
  /**
   * `args` go to the harness executable as is. Rejects with code `agent_not_ready` when the
   * agent comes up blocked, for example on a trust prompt.
   */
  startAgent(input: { name: string; kind: string; paneId: string; args: string[] }): Promise<void>;
  promptAgent(target: string, text: string): Promise<void>;
  listAgents(): Promise<LiveAgent[]>;
  readScreen(target: string, lines: number): Promise<string>;
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpected(detail: string): HerdrError {
  return new HerdrError("unexpected_response", `unexpected herdr response: ${detail}`);
}

function objectField(source: Json, key: string): Json {
  const value = source[key];
  if (!isJson(value)) throw unexpected(`missing object "${key}"`);
  return value;
}

function stringField(source: Json, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw unexpected(`missing string "${key}"`);
  return value;
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && AGENT_STATUSES.includes(value);
}

function parseResult(stdout: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw unexpected("output is not JSON");
  }
  if (!isJson(parsed)) throw unexpected("output is not an object");
  return objectField(parsed, "result");
}

/** herdr prints `{"error":{"code","message"}}` on stderr when a request fails. */
function toHerdrError(stderr: string, fallback: string): HerdrError {
  try {
    const parsed: unknown = JSON.parse(stderr);
    if (isJson(parsed)) {
      const error = objectField(parsed, "error");
      return new HerdrError(stringField(error, "code"), stringField(error, "message"));
    }
  } catch {
    // Not herdr's JSON error shape, for example a usage error or a missing binary.
  }
  return new HerdrError("cli_failed", stderr.trim() || fallback);
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(toHerdrError(stderr, error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseAgent(entry: Json): LiveAgent {
  const status = entry.agent_status;
  return {
    name: typeof entry.name === "string" ? entry.name : undefined,
    paneId: stringField(entry, "pane_id"),
    kind: stringField(entry, "agent"),
    status: isAgentStatus(status) ? status : "unknown",
  };
}

/**
 * Talks to herdr through its CLI. The session it controls is the one herdr
 * exposes to the calling process through `HERDR_SOCKET_PATH`.
 */
export function createHerdrCli(bin: string = process.env.HERDR_BIN_PATH ?? "herdr"): Herdr {
  return {
    async createWorktree({ repo, branch, label, path }) {
      const args = ["worktree", "create", "--cwd", repo, "--branch", branch, "--label", label, "--no-focus"];
      if (path !== undefined) args.push("--path", path);
      const created = parseResult(await run(bin, args));
      const worktree = objectField(created, "worktree");
      return {
        workspaceId: stringField(objectField(created, "workspace"), "workspace_id"),
        paneId: stringField(objectField(created, "root_pane"), "pane_id"),
        path: stringField(worktree, "path"),
        branch: stringField(worktree, "branch"),
      };
    },

    async startAgent({ name, kind, paneId, args }) {
      // Unlike `agent prompt`, `agent start` documents "--" as the start of the harness's own arguments.
      const harnessArgs = args.length > 0 ? ["--", ...args] : [];
      await run(bin, ["agent", "start", name, "--kind", kind, "--pane", paneId, ...harnessArgs]);
    },

    async promptAgent(target, text) {
      // herdr takes this position literally, so text such as "--help" is safe. Do not add a
      // "--" separator: herdr would send that as the prompt and reject the real text.
      await run(bin, ["agent", "prompt", target, text]);
    },

    async listAgents() {
      const agents = parseResult(await run(bin, ["agent", "list"])).agents;
      if (!Array.isArray(agents)) throw unexpected('missing array "agents"');
      return agents.filter(isJson).map(parseAgent);
    },

    readScreen(target, lines) {
      return run(bin, ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)]);
    },
  };
}
