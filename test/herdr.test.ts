import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHerdrCli, HerdrError } from "../src/herdr.ts";

// Records its arguments and replies with trimmed copies of what herdr 0.9.5 prints.
const FAKE_HERDR = `#!/bin/bash
printf '%s\\0' "$@" > "$(dirname "$0")/argv"
case "$1 $2" in
  "worktree create")
    echo '{"id":"cli:worktree:create","result":{"root_pane":{"pane_id":"w2:p1","agent_status":"unknown"},"workspace":{"workspace_id":"w2","label":"w01"},"worktree":{"branch":"drover/w01","path":"/worktrees/w01"},"type":"worktree_created"}}'
    ;;
  "agent start")
    if [ "$3" = "stuck" ]; then
      echo '{"error":{"code":"agent_not_ready","message":"agent stuck is blocked during startup and is not ready for prompts"},"id":"cli:agent:start"}' >&2
      exit 1
    fi
    echo '{"id":"cli:agent:start","result":{"agent":{"agent":"codex","agent_status":"idle","name":"w01","pane_id":"w2:p1"},"type":"agent_started"}}'
    ;;
  "agent list")
    echo '{"id":"cli:agent:list","result":{"agents":[{"agent":"codex","agent_status":"working","name":"w01","pane_id":"w2:p1"},{"agent":"amp","agent_status":"idle","pane_id":"w1:p1"},{"agent":"pi","agent_status":"compacting","name":"w02","pane_id":"w3:p1"}],"type":"agent_list"}}'
    ;;
  "agent prompt")
    echo '{"id":"cli:agent:prompt","result":{"type":"agent_prompted"}}'
    ;;
  *)
    echo "error: unrecognized subcommand" >&2
    exit 2
    ;;
esac
`;

async function fakeHerdr(): Promise<{ bin: string; argv: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), "drover-herdr-"));
  const bin = join(dir, "herdr");
  await writeFile(bin, FAKE_HERDR);
  await chmod(bin, 0o755);
  return {
    bin,
    argv: async () => (await readFile(join(dir, "argv"), "utf8")).split("\0").slice(0, -1),
  };
}

test("a created worktree is read from herdr's reply", async () => {
  const herdr = createHerdrCli((await fakeHerdr()).bin);

  const created = await herdr.createWorktree({ repo: "/repo", branch: "drover/w01", label: "w01" });

  assert.deepEqual(created, { workspaceId: "w2", paneId: "w2:p1", path: "/worktrees/w01", branch: "drover/w01" });
});

test("a worktree path is requested only when one is given", async () => {
  const fake = await fakeHerdr();
  const herdr = createHerdrCli(fake.bin);
  const base = ["worktree", "create", "--cwd", "/repo", "--branch", "drover/w01", "--label", "w01", "--no-focus"];

  await herdr.createWorktree({ repo: "/repo", branch: "drover/w01", label: "w01" });
  assert.deepEqual(await fake.argv(), base);

  await herdr.createWorktree({ repo: "/repo", branch: "drover/w01", label: "w01", path: "/trees/repo/w01" });
  assert.deepEqual(await fake.argv(), [...base, "--path", "/trees/repo/w01"]);
});

test("harness arguments are passed after a separator, and the separator is left out when there are none", async () => {
  const fake = await fakeHerdr();
  const herdr = createHerdrCli(fake.bin);
  const base = ["agent", "start", "w01", "--kind", "codex", "--pane", "w2:p1"];

  await herdr.startAgent({ name: "w01", kind: "codex", paneId: "w2:p1", args: ["--model", "some-model", "-s", "read-only"] });
  assert.deepEqual(await fake.argv(), [...base, "--", "--model", "some-model", "-s", "read-only"]);

  await herdr.startAgent({ name: "w01", kind: "codex", paneId: "w2:p1", args: [] });
  assert.deepEqual(await fake.argv(), base);
});

test("herdr's error code is preserved", async () => {
  const herdr = createHerdrCli((await fakeHerdr()).bin);

  await assert.rejects(
    herdr.startAgent({ name: "stuck", kind: "codex", paneId: "w2:p1", args: [] }),
    (error: unknown) => error instanceof HerdrError && error.code === "agent_not_ready",
  );
});

test("a failure without herdr's error shape is still reported", async () => {
  const herdr = createHerdrCli((await fakeHerdr()).bin);

  await assert.rejects(
    herdr.readScreen("w01", 10),
    (error: unknown) =>
      error instanceof HerdrError && error.code === "cli_failed" && /unrecognized subcommand/.test(error.message),
  );
});

test("agents are listed, including unnamed ones and statuses this version does not know", async () => {
  const herdr = createHerdrCli((await fakeHerdr()).bin);

  assert.deepEqual(await herdr.listAgents(), [
    { name: "w01", paneId: "w2:p1", kind: "codex", status: "working" },
    { name: undefined, paneId: "w1:p1", kind: "amp", status: "idle" },
    { name: "w02", paneId: "w3:p1", kind: "pi", status: "unknown" },
  ]);
});

// herdr 0.9.5 reads the argument after the target literally and rejects anything after a
// "--" separator, so the text must sit directly in that position.
test("a prompt is passed as the one argument after the target, whatever it contains", async () => {
  const fake = await fakeHerdr();
  const text = "--fix the flag parser\nsecond line with 'quotes' and $VARS";

  await createHerdrCli(fake.bin).promptAgent("w01", text);

  assert.deepEqual(await fake.argv(), ["agent", "prompt", "w01", text]);
});
