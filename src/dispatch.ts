import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { type Herdr, HerdrError } from "./herdr.ts";
import type { Ledger, Worker } from "./ledger.ts";

const execFileAsync = promisify(execFile);

/** Where a worker leaves its result, relative to its worktree. */
export const RESULT_DIR = ".drover";

const SCREEN_LINES = 40;

/** herdr error codes that mean the agent is showing a prompt only the user should answer. */
const WAITING_FOR_USER: readonly string[] = ["agent_not_ready", "agent_blocked"];

export interface DispatchDeps {
  herdr: Herdr;
  ledger: Ledger;
  /** Fixed instructions appended after the task. */
  protocol: string;
  now?: () => Date;
}

export interface SpawnInput {
  harness: string;
  repo: string;
  task: string;
  branch?: string;
}

export type SpawnOutcome =
  | { kind: "delivered"; worker: Worker }
  /** The agent is waiting on something only the user can answer; `screen` shows what. */
  | { kind: "pending"; worker: Worker; screen: string };

function timestamp(deps: DispatchDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** Keeps the result file out of `git status` without touching tracked files. */
async function excludeResultDir(worktree: string): Promise<void> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    worktree,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const excludeFile = stdout.trim();
  const entry = `${RESULT_DIR}/`;
  const current = await readIfExists(excludeFile);
  if (current.split("\n").includes(entry)) return;
  await mkdir(dirname(excludeFile), { recursive: true });
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(excludeFile, `${separator}${entry}\n`);
}

/** The task goes first and unchanged; the dispatcher has no repository context to improve it. */
function composePrompt(task: string, protocol: string): string {
  return `${task}\n\n${protocol.trim()}\n`;
}

async function deliver(deps: DispatchDeps, worker: Worker): Promise<Worker> {
  await deps.herdr.promptAgent(worker.id, composePrompt(worker.task, deps.protocol));
  const delivered: Worker = {
    ...worker,
    taskDelivered: true,
    status: "working",
    note: undefined,
    updatedAt: timestamp(deps),
  };
  await deps.ledger.save(delivered);
  return delivered;
}

/** Creates a worktree, starts the harness in it, and hands over the task. */
export async function spawnWorker(deps: DispatchDeps, input: SpawnInput): Promise<SpawnOutcome> {
  const repo = expandHome(input.repo);
  if (!isAbsolute(repo)) throw new Error(`repo must be an absolute path, got "${input.repo}"`);

  const id = await deps.ledger.reserveId();
  const created = await deps.herdr.createWorktree({ repo, branch: input.branch ?? `drover/${id}`, label: id });

  // Recorded before anything else can fail, so a created worktree is never left untracked.
  const createdAt = timestamp(deps);
  const worker: Worker = {
    id,
    harness: input.harness,
    repo,
    worktree: created.path,
    branch: created.branch,
    workspaceId: created.workspaceId,
    paneId: created.paneId,
    task: input.task,
    taskDelivered: false,
    status: "unknown",
    createdAt,
    updatedAt: createdAt,
  };
  await deps.ledger.save(worker);

  try {
    await excludeResultDir(created.path);
    await deps.herdr.startAgent({ name: id, kind: input.harness, paneId: created.paneId });
    return { kind: "delivered", worker: await deliver(deps, worker) };
  } catch (error) {
    if (error instanceof HerdrError && WAITING_FOR_USER.includes(error.code)) {
      const blocked: Worker = { ...worker, status: "blocked", updatedAt: timestamp(deps) };
      await deps.ledger.save(blocked);
      return { kind: "pending", worker: blocked, screen: await deps.herdr.readScreen(id, SCREEN_LINES) };
    }
    // The worker stays in the ledger undelivered, so the next sync retries the handover.
    await deps.ledger.save({ ...worker, note: `setup failed: ${messageOf(error)}`, updatedAt: timestamp(deps) });
    throw error;
  }
}

/**
 * Brings the ledger in line with herdr's live agents, and hands over any task
 * that was held back because its agent was not ready when it was spawned.
 */
export async function syncWorkers(deps: DispatchDeps): Promise<Worker[]> {
  const [workers, agents] = await Promise.all([deps.ledger.workers(), deps.herdr.listAgents()]);
  const synced: Worker[] = [];

  for (const worker of workers) {
    const live =
      agents.find((agent) => agent.name === worker.id) ?? agents.find((agent) => agent.paneId === worker.paneId);
    const status = live?.status ?? "exited";
    let current = worker;

    if (status !== worker.status) {
      current = { ...worker, status, updatedAt: timestamp(deps) };
      await deps.ledger.save(current);
    }

    if (!current.taskDelivered && (status === "idle" || status === "done")) {
      try {
        current = await deliver(deps, current);
      } catch (error) {
        current = { ...current, note: `task delivery failed: ${messageOf(error)}`, updatedAt: timestamp(deps) };
        await deps.ledger.save(current);
      }
    }

    synced.push(current);
  }

  return synced;
}

/** One line per worker, for the dispatcher model to relay. */
export function describeWorker(worker: Worker, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(worker.createdAt)) / 60_000));
  const parts = [
    `${worker.id} ${worker.harness} ${worker.status} ${minutes}m`,
    `worktree=${worker.worktree}`,
    `branch=${worker.branch}`,
  ];
  if (!worker.taskDelivered) parts.push("task not delivered yet");
  if (worker.note) parts.push(`note: ${worker.note}`);
  return parts.join(" | ");
}
