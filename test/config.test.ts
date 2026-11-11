import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig, resolveHarness, worktreePath } from "../src/config.ts";

async function configFile(content: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "drover-config-")), "config.json");
  await writeFile(file, content);
  return file;
}

test("a missing config file means no settings", async () => {
  const config = loadConfig(join(await mkdtemp(join(tmpdir(), "drover-config-")), "absent.json"));

  assert.equal(config.worktreeDirectory, undefined);
  assert.equal(config.harnesses.size, 0);
});

test("settings are read from the file", async () => {
  const config = loadConfig(
    await configFile(
      JSON.stringify({
        worktrees: { directory: "~/trees" },
        harnesses: {
          codex: { args: ["--model", "some-model"] },
          "codex-readonly": { kind: "codex", args: ["--sandbox", "read-only"] },
        },
      }),
    ),
  );

  assert.equal(config.worktreeDirectory, join(homedir(), "trees"));
  assert.deepEqual(resolveHarness(config, "codex"), { kind: "codex", args: ["--model", "some-model"] });
  assert.deepEqual(resolveHarness(config, "codex-readonly"), { kind: "codex", args: ["--sandbox", "read-only"] });
});

test("a harness without settings is started as that herdr kind with no arguments", () => {
  const config = parseConfig({}, "config.json");

  assert.deepEqual(resolveHarness(config, "grok"), { kind: "grok", args: [] });
  // Must not pick up properties every object has.
  assert.deepEqual(resolveHarness(config, "constructor"), { kind: "constructor", args: [] });
});

test("mistakes in the file are reported with the setting they concern", async () => {
  const cases: [unknown, RegExp][] = [
    [{ worktree: { directory: "/trees" } }, /"worktree" is not a known setting/],
    [{ worktrees: { dir: "/trees" } }, /"worktrees\.dir" is not a known setting/],
    [{ worktrees: { directory: "trees" } }, /"worktrees\.directory" must be an absolute path/],
    [{ harnesses: { codex: { args: "--model x" } } }, /"harnesses\.codex\.args" must be a list of strings/],
    [{ harnesses: { codex: { model: "x" } } }, /"harnesses\.codex\.model" is not a known setting/],
    [{ harnesses: { fast: { kind: "" } } }, /"harnesses\.fast\.kind" must be a non-empty string/],
    [[], /the top level must be an object/],
  ];

  for (const [value, expected] of cases) {
    assert.throws(() => parseConfig(value, "config.json"), expected);
  }
  const broken = await configFile("{ not json");
  assert.throws(() => loadConfig(broken), /is not valid JSON/);
});

test("worktree paths follow herdr's layout", () => {
  assert.equal(worktreePath("/trees", "/code/my-app", "drover/w01"), "/trees/my-app/drover-w01");
  assert.equal(worktreePath("/trees", "/code/my-app", "feature/login page"), "/trees/my-app/feature-login-page");
});
