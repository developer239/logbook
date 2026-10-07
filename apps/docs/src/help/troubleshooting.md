# Troubleshooting

Search this page for the message you met: each heading starts with the words Log Book prints. Variable parts, such as a port or a size, are shown with example values.

- [Install and start](#install-and-start): Node.js, Windows, `EACCES`, a busy port, the browser.
- [What the page shows](#what-the-page-shows): the sync control, no data, a failed sync, cards waiting for labels.
- [The warehouse](#the-warehouse): a newer schema, an update while running.
- [Syncing](#syncing): problems in a sync's output.
- [Locks and maintenance](#locks-and-maintenance): "already running", compacting and forgetting.
- [Labelling](#labelling): Claude Code missing or signed out, models, usage limits.
- [Reporting a problem](#reporting-a-problem).

## Install and start

### Log Book needs Node.js 24.15 or newer

```text
Log Book needs Node.js 24.15 or newer; this is Node.js 22.11.0 at /usr/bin/node. Install Node.js 24.15 (https://nodejs.org) or switch to it with your version manager, then run logbook again.
```

Install or switch to Node.js <Fact name="nodeFloor" /> or newer, then run `logbook` again.

Exit code: [5, unsupported environment](/reference/exit-codes#unsupported-environment).

### Log Book runs on macOS and Linux

```text
Log Book runs on macOS and Linux. On Windows, run it inside WSL, where your agents run.
```

On Windows, install and run Log Book inside WSL 2, where your agents keep their data. npm refuses a Windows install with `EBADPLATFORM`.

Exit code: [5, unsupported environment](/reference/exit-codes#unsupported-environment).

### EACCES on npm install -g

npm's global directory belongs to root, as with the Node.js a Linux distribution packages. Install Node.js with a version manager, or give npm a prefix of your own, as [Quick start](/start/quick-start#if-npm-install-g-fails-with-eacces) shows. Do not install as root.

### Port 7314 on 127.0.0.1 is in use by another program

```text
Port 7314 on 127.0.0.1 is in use by another program. Start Log Book on another port: logbook --port 7315
```

Start it on another port:

```sh
logbook --port 7400
```

The line says `used by another Log Book, on a different warehouse` when that is what holds the port.

Exit code: [4, port in use](/reference/exit-codes#port-in-use).

### Log Book is already running at

```text
Log Book is already running at http://127.0.0.1:7314
```

A second `logbook` on the same warehouse opens the first one's page and ends. Nothing is wrong.

Exit code: [0, success](/reference/exit-codes#success).

### Browser not opened

```text
Browser      not opened: no xdg-open on this machine. Open http://127.0.0.1:7314 yourself, or start with logbook --no-open.
```

Log Book keeps running; open the printed URL yourself. On a headless machine or over SSH, start with `--no-open`:

```sh
logbook --no-open
```

## What the page shows

### The sync control

<Shot id="sync-control" caption="The top bar: when Log Book last synced, and the Label control." />

| It reads                          | What it means                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `Synced 5 min ago`                | The last sync imported everything.                                                    |
| `Synced 5 min ago, with problems` | It imported what it could. Point at it to read the problem, or run `logbook sync`.    |
| `Sync failed 5 min ago`           | The last sync failed or was stopped. The page shows the error.                        |
| `Syncing… (since 2 min)`          | A sync is running; another cannot start until it ends.                                |
| `Never synced`                    | Before the first sync. On the first run, the page reloads itself until the sync ends. |

Click it to sync now. During `logbook compact` or `logbook forget`, it reads `Compacting (since 2 min)` or `Forgetting sessions (since 2 min)`: pages keep working, and syncs and labelling wait until it ends.

### No agent data found yet

The page lists each agent with where Log Book looked and the variable that points it elsewhere, such as `CLAUDE_CONFIG_DIR` for Claude Code and `OPENCODE_DB` for OpenCode. Run the agent once on this machine, or set the variable, and sync again. In a terminal the same message reads:

```text
No agent data found yet. Log Book reads what Claude Code and OpenCode keep on this machine; it will pick them up on the next sync once either has run here.
```

[Environment variables](/reference/environment) lists the variables.

### The last sync failed

When a sync could import nothing, the page shows the problem, or `The last sync did not finish.`, and asks you to run a sync in a terminal to see its full output:

```sh
logbook sync
```

### These need labels from a model

The cards that read model labels say <Ui page="/">These need labels from a model.</Ui> until you label your sessions. The rest of the dashboard works without them. [Labels](/labelling/) shows how to preview and start a run.

## The warehouse

### The warehouse is at schema

```text
The warehouse is at schema 2; this Log Book (1.4.0) reads schema 1. Update with npm install -g @log-book/cli@latest.
```

A newer Log Book migrated the warehouse, and this one cannot read it. Update to the version the line names; the page says the same. To try a preview without this happening, give it [a warehouse of its own](/manage#try-a-preview-release).

Exit code: [6, newer warehouse](/reference/exit-codes#newer-warehouse).

### Log Book was updated while running

```text
Log Book was updated while running. Press Ctrl+C and start logbook again.
```

Press Ctrl+C and start `logbook` again; the new version migrates the warehouse if it needs to.

Exit code: [9, updated while running](/reference/exit-codes#updated-while-running).

## Syncing

### Sync finished with

```text
Sync finished with 2 problems: Claude Code: 2 transcripts could not be read: ~/.claude/projects/shop/de30da7a-0000-4000-8000-000000000001.jsonl: unexpected end of the file
```

The sync imported what it could; the lines before it name each problem, and the next sync tries again. A line that says to upgrade Log Book means the agent writes a format this version does not know yet: update Log Book.

Exit code: [10, partial failure](/reference/exit-codes#partial-failure).

### sync failed, and Full output

```text
14:05 sync failed (exit 1): the warehouse file could not be opened. Full output: ~/.local/share/log-book/logs/sync-2026-10-06T14-05-00.log
```

A scheduled sync failed; `logbook` keeps running and tries again at the next one. Read the log the line names (Log Book keeps the newest 20), or run `logbook sync` to see the output in your terminal.

## Locks and maintenance

A sync, a labelling run, `logbook labels drop`, `logbook compact` and `logbook forget` each hold a lock on the warehouse, and a command that needs a held lock stops before it changes anything. Every such message names the process that holds the lock and its lock file:

1. If that process is running, wait for it to end, or stop it where it was started (Ctrl+C in its terminal, or Stop on the labelling page).
2. If it is not running, it was stopped without cleaning up: delete the lock file the message names.
3. Run your command again.

| Message starts with                                      | You met                                                  |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `A sync is already running on this warehouse`            | a sync, while running a sync, a compact or a forget      |
| `Maintenance is running on this warehouse`               | a compact or a forget, while syncing or labelling        |
| `Another labelling command is running on this warehouse` | another labelling run or drop                            |
| `A labelling command is running on this warehouse`       | a labelling run or drop, while running compact or forget |

For example:

```text
Maintenance is running on this warehouse: logbook compact is rewriting it (pid 4242, lock file ~/.local/share/log-book/warehouse.db.labels.lock). Run this again once it has ended. If none is running, delete that file.
```

A labelling run that meets maintenance stops before any model call, so it spends nothing.

Exit code: [3, already running](/reference/exit-codes#already-running).

### Compacting, and the free disk it needs

```text
Compacting ~/.local/share/log-book/warehouse.db (1.3 GB). This rewrites the whole file and needs up to 2.6 GB of free disk; syncs and labelling wait until it ends.
```

When the disk fills up, the command ends with SQLite's message, such as `database or disk is full`, and the warehouse stays as it was. Free some space and run it again.

Exit code on a full disk: [1, failure](/reference/exit-codes#failure).

### Compacting stopped

```text
Compacting stopped. SQLite rolled the rewrite back, so the warehouse file is unchanged: 1.3 GB, the same rows.
```

The file is as it was. When the rewrite had already finished, the line says so instead, and the file shrinks to its new size at a later sync.

Exit code: [130, interrupted](/reference/exit-codes#interrupted).

### Forgetting stopped

```text
Forgetting stopped before anything was deleted. Nothing was forgotten, and the warehouse file is unchanged.
```

When it had already deleted the sessions, they are gone, but their text may still be in the file's free space:

```text
Forgot 12 sessions and 48 labels, but compacting stopped, so their text may still be in the file's free space. Run logbook compact to remove it.
```

Run `logbook compact` to remove it.

Exit code: [130, interrupted](/reference/exit-codes#interrupted).

## Labelling

### needs Claude Code

```text
needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN
```

Install Claude Code, or set `CLAUDE_BIN` to the `claude` you use. When the line says `needs Claude Code 2.1.286 or newer`, update it:

```sh
claude update
```

Exit code: [7, missing prerequisite](/reference/exit-codes#missing-prerequisite).

### Claude Code is not signed in

```text
Claude Code is not signed in. Run claude, sign in, then run this again.
```

Exit code: [7, missing prerequisite](/reference/exit-codes#missing-prerequisite).

### --model must start with a letter or digit

```text
--model must start with a letter or digit and hold only letters, digits, . _ - : or @ (at most 128 characters), got "claude haiku"
```

Pass a full model id:

```sh
logbook labels update --model claude-sonnet-5-5
```

Exit code: [2, usage error](/reference/exit-codes#usage-error).

### Labelling failed on

```text
Labelling failed on claude-example-1: <what Claude Code said>. 0 of 2,214 records labelled and kept. Run the same command again once fixed, for example with another --model.
```

Claude Code refused the run, for example because your plan or provider does not offer that model. Log Book keeps no list of models, so it learns this from the first request. Run it again with a model your plan offers.

Exit code: [1, failure](/reference/exit-codes#failure).

### Stopped at your Claude usage limit

```text
Stopped at your Claude usage limit (Example limit reached, resets at 5pm). 1,240 of 2,214 records labelled and kept. Run the same command again once the limit resets.
```

Every finished batch is kept. Run the same command again once the limit resets, and it continues where it stopped.

Exit code: [8, usage limit](/reference/exit-codes#usage-limit).

### Labelling stopped: Claude Code could not reach its API

```text
Labelling stopped: Claude Code could not reach its API (No response from API). 1,240 of 2,214 records labelled and kept. Run the same command again when you are online.
```

Every finished batch is kept. Run the same command again when you are online.

Exit code: [1, failure](/reference/exit-codes#failure).

## Reporting a problem

When nothing here helps, open an issue on [GitHub](https://github.com/developer239/logbook/issues) with the message you met and what `logbook doctor` prints:

```sh
logbook doctor
```

```text
Log Book <version>, Node.js <version>, linux x64
Warehouse   ~/.local/share/log-book/warehouse.db (schema 1, 261 MB; no host running)
Claude Code found at ~/.claude/projects
OpenCode    not on this machine (no ~/.local/share/opencode/opencode.db; set OPENCODE_DB if OpenCode keeps its data elsewhere)
Labelling   needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN
```

It holds no session, prompt or project name.
