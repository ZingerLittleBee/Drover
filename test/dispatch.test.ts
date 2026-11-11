import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Config } from "../src/config.ts";
import { type SpawnDeps, spawnWorker, syncWorkers } from "../src/dispatch.ts";
import { type CreatedWorktree, type Herdr, HerdrError, type LiveAgent } from "../src/herdr.ts";
import { Ledger } from "../src/ledger.ts";

const execFileAsync = promisify(execFile);

const PROTOCOL = "---\nWrite .drover/RESULT.md when done.";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout;
}

/**
 * Stands in for the herdr server. Worktrees are real git worktrees so the
 * git-facing behavior is exercised; agents are in-memory.
 */
class FakeHerdr implements Herdr {
  readonly agents: LiveAgent[] = [];
  readonly prompts: { target: string; text: string }[] = [];
  readonly started: { name: string; kind: string; args: string[] }[] = [];
  /** The `path` of each worktree request; undefined when herdr was left to choose. */
  readonly requestedPaths: (string | undefined)[] = [];
  blockedAtStartup = false;
  /** Makes the next prompt fail once. */
  promptFailure: HerdrError | undefined;
  screen = "";
  readonly #worktreeRoot: string;

  constructor(worktreeRoot: string) {
    this.#worktreeRoot = worktreeRoot;
  }

  async createWorktree(input: {
    repo: string;
    branch: string;
    label: string;
    path?: string;
  }): Promise<CreatedWorktree> {
    this.requestedPaths.push(input.path);
    const path = input.path ?? join(this.#worktreeRoot, input.label);
    try {
      await git(input.repo, "worktree", "add", "-q", "-b", input.branch, path);
    } catch {
      throw new HerdrError("worktree_create_failed", `cannot create worktree for ${input.repo}`);
    }
    return { workspaceId: "w1", paneId: `w1:${input.label}`, path, branch: input.branch };
  }

  async startAgent(input: { name: string; kind: string; paneId: string; args: string[] }): Promise<void> {
    this.started.push({ name: input.name, kind: input.kind, args: input.args });
    const status = this.blockedAtStartup ? "blocked" : "idle";
    this.agents.push({ name: input.name, paneId: input.paneId, kind: input.kind, status });
    if (this.blockedAtStartup) throw new HerdrError("agent_not_ready", `agent ${input.name} is blocked during startup`);
  }

  async promptAgent(target: string, text: string): Promise<void> {
    const agent = this.agent(target);
    if (this.promptFailure) {
      const failure = this.promptFailure;
      this.promptFailure = undefined;
      throw failure;
    }
    if (agent.status === "blocked") throw new HerdrError("agent_blocked", `agent ${target} is blocked`);
    this.prompts.push({ target, text });
    agent.status = "working";
  }

  async listAgents(): Promise<LiveAgent[]> {
    return this.agents.map((agent) => ({ ...agent }));
  }

  async readScreen(): Promise<string> {
    return this.screen;
  }

  agent(name: string): LiveAgent {
    const agent = this.agents.find((candidate) => candidate.name === name);
    if (!agent) throw new HerdrError("agent_not_found", `agent target ${name} not found`);
    return agent;
  }
}

async function setup(
  configure: (root: string) => Config = () => ({ harnesses: new Map() }),
): Promise<{ deps: SpawnDeps; herdr: FakeHerdr; ledger: Ledger; repo: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "drover-dispatch-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(
    repo,
    "-c",
    "user.name=Drover Test",
    "-c",
    "user.email=drover@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  const herdr = new FakeHerdr(join(root, "worktrees"));
  const ledger = new Ledger(join(root, "state", "ledger.json"));
  return { deps: { herdr, ledger, protocol: PROTOCOL, config: configure(root) }, herdr, ledger, repo, root };
}

test("the task reaches the agent verbatim, followed by the result protocol", async () => {
  const { deps, herdr, ledger, repo } = await setup();
  const task = "- 修复登录页\n  keep `the --flags` as written\n\nSecond paragraph.";

  const outcome = await spawnWorker(deps, { harness: "codex", repo, task });

  assert.equal(outcome.kind, "delivered");
  assert.deepEqual(herdr.prompts, [{ target: outcome.worker.id, text: `${task}\n\n${PROTOCOL}\n` }]);
  const [stored] = await ledger.workers();
  assert.equal(stored?.task, task);
  assert.equal(stored?.status, "working");
  assert.equal(stored?.taskDelivered, true);
  assert.equal(stored?.branch, `drover/${outcome.worker.id}`);
});

test("a configured harness is started with its kind and arguments", async () => {
  const { deps, herdr, ledger, repo } = await setup(() => ({
    harnesses: new Map([["codex-readonly", { kind: "codex", args: ["--sandbox", "read-only"] }]]),
  }));

  const configured = await spawnWorker(deps, { harness: "codex-readonly", repo, task: "one" });
  const plain = await spawnWorker(deps, { harness: "grok", repo, task: "two" });

  assert.deepEqual(herdr.started, [
    { name: configured.worker.id, kind: "codex", args: ["--sandbox", "read-only"] },
    { name: plain.worker.id, kind: "grok", args: [] },
  ]);
  // The ledger keeps the name the user chose, which says more than the kind.
  assert.deepEqual(
    (await ledger.workers()).map((worker) => worker.harness),
    ["codex-readonly", "grok"],
  );
});

test("worktrees go under the configured directory, and herdr chooses when none is set", async () => {
  const configured = await setup((root) => ({ worktreeDirectory: join(root, "trees"), harnesses: new Map() }));
  const { worker } = await spawnWorker(configured.deps, { harness: "codex", repo: configured.repo, task: "one" });
  assert.equal(worker.worktree, join(configured.root, "trees", "repo", `drover-${worker.id}`));
  assert.equal(await git(worker.worktree, "branch", "--show-current"), `drover/${worker.id}\n`);

  const unset = await setup();
  await spawnWorker(unset.deps, { harness: "codex", repo: unset.repo, task: "one" });
  assert.deepEqual(unset.herdr.requestedPaths, [undefined]);
});

test("a worker's result file does not show up in git status", async () => {
  const { deps, repo } = await setup();
  const first = await spawnWorker(deps, { harness: "codex", repo, task: "one" });
  const second = await spawnWorker(deps, { harness: "codex", repo, task: "two" });

  for (const { worker } of [first, second]) {
    await mkdir(join(worker.worktree, ".drover"));
    await writeFile(join(worker.worktree, ".drover", "RESULT.md"), "done");
    assert.equal(await git(worker.worktree, "status", "--porcelain"), "");
  }
  // Both worktrees share one exclude file; the entry must not pile up.
  const excludeFile = await git(repo, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  const entries = (await readFile(excludeFile.trim(), "utf8")).split("\n").filter((line) => line === ".drover/");
  assert.equal(entries.length, 1);
});

test("a task is held while the agent is blocked at startup, then delivered once it is ready", async () => {
  const { deps, herdr, ledger, repo } = await setup();
  herdr.blockedAtStartup = true;
  herdr.screen = "Trust this folder?";

  const outcome = await spawnWorker(deps, { harness: "codex", repo, task: "the task" });

  assert.equal(outcome.kind, "pending");
  assert.equal(outcome.kind === "pending" && outcome.screen, "Trust this folder?");
  assert.deepEqual(herdr.prompts, []);

  // Still blocked: nothing is sent.
  const [stillBlocked] = await syncWorkers(deps);
  assert.equal(stillBlocked?.status, "blocked");
  assert.equal(stillBlocked?.taskDelivered, false);
  assert.deepEqual(herdr.prompts, []);

  // The user answers the prompt and the agent becomes ready.
  herdr.agent(outcome.worker.id).status = "idle";
  const [ready] = await syncWorkers(deps);
  assert.equal(ready?.taskDelivered, true);
  assert.equal(ready?.status, "working");
  assert.deepEqual(herdr.prompts, [{ target: outcome.worker.id, text: `the task\n\n${PROTOCOL}\n` }]);

  // A later sync must not send the task a second time.
  herdr.agent(outcome.worker.id).status = "done";
  await syncWorkers(deps);
  assert.equal(herdr.prompts.length, 1);
  assert.equal((await ledger.workers())[0]?.status, "done");
});

test("a task that could not be handed over is kept and retried on the next sync", async () => {
  const { deps, herdr, ledger, repo } = await setup();
  herdr.promptFailure = new HerdrError("cli_failed", "herdr went away");

  await assert.rejects(spawnWorker(deps, { harness: "codex", repo, task: "the task" }), /herdr went away/);

  const [kept] = await ledger.workers();
  assert.equal(kept?.taskDelivered, false);
  assert.match(kept?.note ?? "", /herdr went away/);

  const [retried] = await syncWorkers(deps);
  assert.equal(retried?.taskDelivered, true);
  assert.equal(retried?.note, undefined);
  assert.equal(herdr.prompts.length, 1);
});

test("a worker whose agent is gone is reported as exited", async () => {
  const { deps, herdr, repo } = await setup();
  await spawnWorker(deps, { harness: "codex", repo, task: "the task" });
  herdr.agents.length = 0;

  const [worker] = await syncWorkers(deps);

  assert.equal(worker?.status, "exited");
});

test("a failed worktree leaves no worker behind", async () => {
  const { deps, ledger } = await setup();

  await assert.rejects(
    spawnWorker(deps, { harness: "codex", repo: join(tmpdir(), "drover-no-such-repo"), task: "the task" }),
    (error: unknown) => error instanceof HerdrError && error.code === "worktree_create_failed",
  );
  assert.deepEqual(await ledger.workers(), []);
});

test("a relative repository path is rejected before anything is created", async () => {
  const { deps, ledger } = await setup();

  await assert.rejects(spawnWorker(deps, { harness: "codex", repo: "some/repo", task: "the task" }), /absolute path/);
  assert.deepEqual(await ledger.workers(), []);
});
