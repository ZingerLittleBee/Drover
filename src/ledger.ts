import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentStatus } from "./herdr.ts";

/** herdr's agent status, plus `exited` once the agent is no longer running. */
export type WorkerStatus = AgentStatus | "exited";

export interface Worker {
  /** Also the herdr agent name, so one identifier works everywhere. */
  id: string;
  harness: string;
  repo: string;
  worktree: string;
  branch: string;
  workspaceId: string;
  paneId: string;
  /** The user's task text, verbatim. */
  task: string;
  /** False while the agent has not been ready to receive the task. */
  taskDelivered: boolean;
  status: WorkerStatus;
  /** The last problem Drover hit with this worker, if any. */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface LedgerFile {
  version: 1;
  nextSeq: number;
  workers: Worker[];
}

export function defaultLedgerPath(): string {
  const stateDir =
    process.env.DROVER_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "drover");
  return join(stateDir, "ledger.json");
}

function isLedgerFile(value: unknown): value is LedgerFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LedgerFile>;
  return candidate.version === 1 && typeof candidate.nextSeq === "number" && Array.isArray(candidate.workers);
}

/**
 * The record of every worker Drover has started. It lives on disk because the
 * dispatcher's conversation gets compacted and its process gets restarted.
 */
export class Ledger {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string = defaultLedgerPath()) {
    this.#path = path;
  }

  workers(): Promise<Worker[]> {
    return this.#exclusive(async () => (await this.#read()).workers);
  }

  /** Reserves the next worker id. Ids are never reused, even if the worker is never saved. */
  reserveId(): Promise<string> {
    return this.#exclusive(async () => {
      const file = await this.#read();
      const id = `w${String(file.nextSeq).padStart(2, "0")}`;
      await this.#write({ ...file, nextSeq: file.nextSeq + 1 });
      return id;
    });
  }

  /** Inserts the worker, or replaces the stored worker with the same id. */
  save(worker: Worker): Promise<void> {
    return this.#exclusive(async () => {
      const file = await this.#read();
      const others = file.workers.filter((existing) => existing.id !== worker.id);
      const workers = [...others, worker].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await this.#write({ ...file, workers });
    });
  }

  /** Tool calls can run in parallel, so each read-modify-write runs alone. */
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<LedgerFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, nextSeq: 1, workers: [] };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    // Resetting here would silently lose track of running workers.
    if (!isLedgerFile(parsed)) throw new Error(`Drover ledger at ${this.#path} is not readable; fix or move it`);
    return parsed;
  }

  async #write(file: LedgerFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temporary, this.#path);
  }
}
