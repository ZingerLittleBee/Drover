# Drover

A dispatcher for coding agents that run in [herdr](https://herdr.dev).

Drover is a [pi](https://pi.dev) session with one extension loaded and every other tool turned off. It starts workers and keeps track of them. It cannot do the work itself.

You tell Drover what to do, in which repository, and with which harness. It creates a git worktree, starts the harness there through the herdr CLI, and hands over your task.

## The task is passed on unchanged

Drover has no view of your repository, so it does not split or rewrite tasks. The worker receives the text you wrote, followed by a short fixed protocol asking it to leave its result in `.drover/RESULT.md`. That directory is added to the repository's `.git/info/exclude`, so it stays out of `git status`.

## Requirements

- herdr, with the integrations for your harnesses installed (`herdr integration status`)
- pi
- Node.js 22.18 or later

Developed against herdr 0.9.5 and pi 1.4.0.

## Usage

Start Drover in a herdr pane:

```bash
git clone https://github.com/ZingerLittleBee/Drover
Drover/bin/drover
```

Then ask for work in plain language:

```
Use codex in ~/code/my-app for this task: <your task>
```

| Tool | What it does |
| --- | --- |
| `spawn_worker` | Creates a worktree on a new `drover/<id>` branch, starts the harness in it, and delivers the task |
| `list_workers` | Lists every worker with its live herdr status |

Some harnesses open on a question only you should answer, such as whether to trust a folder. Drover then shows you the agent's screen and holds the task. It is delivered once the agent is ready, the next time workers are listed.

Load Drover with `bin/drover` rather than `pi install`. Installing it would add its tools to every pi session, including pi sessions that are themselves workers.

## Configuration

Optional. Drover reads `~/.config/drover/config.json`. `XDG_CONFIG_HOME` is honored, and `DROVER_CONFIG` names another file. The file is read each time a worker is spawned, so a change applies to the next worker.

```json
{
  "worktrees": {
    "directory": "~/worktrees"
  },
  "harnesses": {
    "codex": {
      "args": ["--model", "<model>", "--sandbox", "workspace-write", "--ask-for-approval", "never"]
    },
    "codex-readonly": {
      "kind": "codex",
      "args": ["--sandbox", "read-only"]
    },
    "claude": {
      "args": ["--model", "<model>", "--permission-mode", "acceptEdits"]
    }
  }
}
```

| Setting | Meaning |
| --- | --- |
| `worktrees.directory` | Where worktrees are created, as `<directory>/<repository name>/<branch>`. Without it, herdr uses its own `[worktrees] directory`. |
| `harnesses.<name>.args` | Arguments passed to the harness as is. This is where its model and permissions are set. |
| `harnesses.<name>.kind` | The herdr agent kind to start. Defaults to `<name>`. |

An entry named after a herdr agent kind sets how that kind is started. An entry with any other name is a preset you ask for by name, as in "use codex-readonly in ~/code/my-app for this task". A harness without an entry is started with no extra arguments.

Each harness has its own flags, so Drover does not translate them. The ones that matter most:

| Harness | Model | Permissions |
| --- | --- | --- |
| codex | `--model` | `--sandbox read-only\|workspace-write\|danger-full-access`, `--ask-for-approval` |
| claude | `--model` | `--permission-mode` |
| grok | `--model` | `--permission-mode`, `--sandbox` |
| pi | `--model`, `--thinking` | `--tools`, `--exclude-tools` |
| opencode | | `--auto` |

These are from codex 0.167, claude 2.1, grok 1.0, pi 1.4 and opencode 2.0. Run `<harness> --help` for the current list.

## State

Workers are recorded in `~/.local/state/drover/ledger.json`, so they survive a restart of the dispatcher. `XDG_STATE_HOME` is honored, and `DROVER_STATE_DIR` overrides the directory.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

To try a change against a real herdr without touching your own session, run an isolated one:

```bash
herdr --session drover-dev server &
export HERDR_SOCKET_PATH=~/.config/herdr/sessions/drover-dev/herdr.sock
export DROVER_STATE_DIR="$(mktemp -d)"
env -u HERDR_PANE_ID bin/drover --no-session -p "Use pi in /path/to/a/scratch/repo for this task: reply OK" < /dev/null

herdr session stop drover-dev
herdr session delete drover-dev
```

`pi -p` waits for standard input to close when it is not a terminal, hence `< /dev/null`. Worktrees are created in the directory herdr or the Drover config names, so remove the ones the trial created. Set `DROVER_CONFIG` as well to try a config without touching your own.

## Status

Early. Dispatching works. Not built yet:

- Waking the dispatcher when a worker finishes, gets blocked or exits, and reporting its result. Today it only checks when asked.
- Sending follow-ups to a worker and closing one
