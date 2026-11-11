import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { type DispatchDeps, describeWorker, spawnWorker, syncWorkers } from "./dispatch.ts";
import { createHerdrCli } from "./herdr.ts";
import { Ledger } from "./ledger.ts";

const PROTOCOL_FILE = new URL("../prompts/protocol.md", import.meta.url);

const herdr = createHerdrCli();
const ledger = new Ledger();

/** Read on every use so the protocol can be edited without restarting the dispatcher. */
async function loadDeps(): Promise<DispatchDeps> {
  return { herdr, ledger, protocol: await readFile(PROTOCOL_FILE, "utf8") };
}

/** Tells the model which harness names the user has set up, so it can pass them through. */
function configuredHarnessHint(): string {
  try {
    const names = [...loadConfig().harnesses.keys()];
    return names.length > 0 ? ` Harnesses configured for Drover: ${names.join(", ")}.` : "";
  } catch {
    // A broken config is reported when a worker is spawned, where the user can act on it.
    return "";
  }
}

const spawnWorkerTool = defineTool({
  name: "spawn_worker",
  label: "Spawn worker",
  description:
    "Start a coding agent in a new git worktree of a repository and hand it a task. " +
    "The task text is delivered to the agent verbatim.",
  parameters: Type.Object({
    harness: Type.String({
      description:
        "Harness to start: a herdr agent kind such as codex, grok, claude or pi, or a harness name " +
        `the user has configured. Use the name the user gave.${configuredHarnessHint()}`,
    }),
    repo: Type.String({ description: "Absolute path of the git repository the task applies to" }),
    task: Type.String({
      description: "The user's task text, verbatim. Do not summarize, translate or restructure it.",
    }),
    branch: Type.Optional(
      Type.String({ description: "Branch name for the new worktree. Defaults to drover/<worker id>." }),
    ),
  }),
  // Spawns allocate ids and worktrees; running them one at a time keeps that order predictable.
  executionMode: "sequential",

  async execute(_toolCallId, params) {
    // The config is read per spawn, so edits apply to the next worker without a restart.
    const outcome = await spawnWorker({ ...(await loadDeps()), config: loadConfig() }, params);
    const { worker } = outcome;
    const where = `${worker.worktree} (branch ${worker.branch})`;
    const text =
      outcome.kind === "delivered"
        ? `Worker ${worker.id} (${worker.harness}) is working in ${where}. The task was delivered.`
        : `Worker ${worker.id} (${worker.harness}) was created in ${where}, but the agent is waiting for the ` +
          "user and has not received the task. The task is delivered once the agent is ready " +
          `(checked on list_workers).\n\nAgent screen:\n${outcome.screen.trim()}`;
    return { content: [{ type: "text", text }], details: { workers: [worker] } };
  },
});

const listWorkersTool = defineTool({
  name: "list_workers",
  label: "List workers",
  description:
    "List every worker with its current status. Also delivers tasks that were held back because their agent was not ready.",
  parameters: Type.Object({}),
  executionMode: "sequential",

  async execute() {
    const workers = await syncWorkers(await loadDeps());
    const now = new Date();
    const text = workers.length === 0 ? "No workers." : workers.map((worker) => describeWorker(worker, now)).join("\n");
    return { content: [{ type: "text", text }], details: { workers } };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(spawnWorkerTool);
  pi.registerTool(listWorkersTool);

  // The dispatcher must not be able to do the work itself, whatever flags pi was started with.
  pi.on("session_start", () => {
    pi.setActiveTools([spawnWorkerTool.name, listWorkersTool.name]);
  });
}
