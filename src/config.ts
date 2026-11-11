import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

/** How one harness is launched. */
export interface Harness {
  /** The herdr agent kind to start. */
  kind: string;
  /** Arguments passed to the harness as is, for example its model and permission flags. */
  args: string[];
}

export interface Config {
  /** Where worktrees are created. When unset, herdr uses its own `[worktrees] directory`. */
  worktreeDirectory?: string;
  /** Launch settings by harness name. */
  harnesses: Map<string, Harness>;
}

type Json = Record<string, unknown>;

export function defaultConfigPath(): string {
  return (
    process.env.DROVER_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "drover", "config.json")
  );
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function invalid(file: string, setting: string, expectation: string): Error {
  return new Error(`Drover config ${file}: ${setting} ${expectation}`);
}

function objectAt(value: unknown, file: string, setting: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(file, setting, "must be an object");
  }
  return value as Json;
}

/** A misspelled setting would otherwise be ignored without a word. */
function rejectUnknownKeys(source: Json, known: readonly string[], file: string, prefix: string): void {
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) {
      throw invalid(file, `"${prefix}${key}"`, `is not a known setting (known: ${known.join(", ")})`);
    }
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validates parsed JSON. `file` only names the source in error messages. */
export function parseConfig(value: unknown, file: string): Config {
  const root = objectAt(value, file, "the top level");
  rejectUnknownKeys(root, ["worktrees", "harnesses"], file, "");
  const config: Config = { harnesses: new Map() };

  if (root.worktrees !== undefined) {
    const worktrees = objectAt(root.worktrees, file, '"worktrees"');
    rejectUnknownKeys(worktrees, ["directory"], file, "worktrees.");
    if (worktrees.directory !== undefined) {
      if (typeof worktrees.directory !== "string") throw invalid(file, '"worktrees.directory"', "must be a string");
      const directory = expandHome(worktrees.directory);
      if (!isAbsolute(directory)) {
        throw invalid(file, '"worktrees.directory"', "must be an absolute path or start with ~/");
      }
      config.worktreeDirectory = directory;
    }
  }

  if (root.harnesses !== undefined) {
    for (const [name, entry] of Object.entries(objectAt(root.harnesses, file, '"harnesses"'))) {
      const setting = `harnesses.${name}`;
      const harness = objectAt(entry, file, `"${setting}"`);
      rejectUnknownKeys(harness, ["kind", "args"], file, `${setting}.`);
      const kind = harness.kind ?? name;
      if (typeof kind !== "string" || kind === "") {
        throw invalid(file, `"${setting}.kind"`, "must be a non-empty string");
      }
      const args = harness.args ?? [];
      if (!isStringList(args)) throw invalid(file, `"${setting}.args"`, "must be a list of strings");
      config.harnesses.set(name, { kind, args });
    }
  }

  return config;
}

/** Reads the config file. A missing file means no settings. */
export function loadConfig(file: string = defaultConfigPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { harnesses: new Map() };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid(file, "the file", `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseConfig(parsed, file);
}

/** A name without an entry is taken to be a herdr agent kind and started without extra arguments. */
export function resolveHarness(config: Config, name: string): Harness {
  return config.harnesses.get(name) ?? { kind: name, args: [] };
}

/** Mirrors herdr's own layout: `<directory>/<repository name>/<branch with separators flattened>`. */
export function worktreePath(directory: string, repo: string, branch: string): string {
  return join(directory, basename(repo), branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
}
