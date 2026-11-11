import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Ledger, type Worker } from "../src/ledger.ts";

async function newLedgerPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "drover-ledger-")), "state", "ledger.json");
}

function worker(id: string, overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    harness: "codex",
    repo: "/repo",
    worktree: `/worktrees/${id}`,
    branch: `drover/${id}`,
    workspaceId: "w1",
    paneId: "w1:p1",
    task: "do the thing",
    taskDelivered: true,
    status: "working",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("workers survive a restart", async () => {
  const path = await newLedgerPath();
  await new Ledger(path).save(worker("w01"));

  assert.deepEqual(await new Ledger(path).workers(), [worker("w01")]);
});

test("concurrent callers get distinct ids", async () => {
  const ledger = new Ledger(await newLedgerPath());

  const ids = await Promise.all(Array.from({ length: 8 }, () => ledger.reserveId()));

  assert.equal(new Set(ids).size, 8);
});

test("ids are not reused after a restart", async () => {
  const path = await newLedgerPath();
  const first = await new Ledger(path).reserveId();

  assert.notEqual(await new Ledger(path).reserveId(), first);
});

test("saving a worker again replaces the stored one", async () => {
  const ledger = new Ledger(await newLedgerPath());
  await ledger.save(worker("w01", { status: "working" }));
  await ledger.save(worker("w01", { status: "done" }));

  assert.deepEqual(await ledger.workers(), [worker("w01", { status: "done" })]);
});

test("a corrupt ledger is refused instead of being reset", async () => {
  const path = await newLedgerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ not json");

  await assert.rejects(new Ledger(path).workers(), /not readable/);
  await assert.rejects(new Ledger(path).reserveId(), /not readable/);
});
