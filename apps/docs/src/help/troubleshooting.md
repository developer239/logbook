# Troubleshooting

Each entry is headed by the first words of a message as Log Book prints it, so you can search this page for a message you met. Variable parts, such as a port or a size, are shown with example values.

## Install and start

### Log Book needs Node.js 24 or newer

```text
Log Book needs Node.js 24 or newer; this is Node.js 22.11.0 at /usr/bin/node. Install Node.js 24 (https://nodejs.org) or switch to it with your version manager, then run logbook again.
```

The Node.js that runs `logbook` is older than Log Book needs. Install Node.js <Fact name="nodeFloor" /> or newer, or switch to it with your version manager, and run `logbook` again. [Install](/start/install#requirements) says why.

Exit code: [5, unsupported environment](/reference/exit-codes#unsupported-environment).

### Log Book runs on macOS and Linux

```text
Log Book runs on macOS and Linux. On Windows, run it inside WSL, where your agents run.
```

On Windows, npm refuses the install with `EBADPLATFORM`, and a `logbook` installed anyway stops with this line. Install and run Log Book inside WSL 2, where your agents keep their data.

Exit code: [5, unsupported environment](/reference/exit-codes#unsupported-environment).

### EACCES on npm install -g

On Linux with your distribution's Node.js, the global install fails with `EACCES` because npm's global directory belongs to root. Install Node.js with a version manager, or give npm a prefix of your own, as [Install](/start/install#if-npm-install-g-fails-with-eacces) shows. Do not install with root's rights.

### Port 7314 on 127.0.0.1 is in use by another program

```text
Port 7314 on 127.0.0.1 is in use by another program. Start Log Book on another port: logbook --port 7315
```

Another program listens on the port Log Book wants. Start Log Book on another port:

```sh
logbook --port 7400
```

When the port is held by another Log Book that serves a different warehouse, the line says so:

```text
Port 7314 on 127.0.0.1 is used by another Log Book, on a different warehouse. Start this one on another port: logbook --port 7315
```

Exit code: [4, port in use](/reference/exit-codes#port-in-use).

### Log Book is already running at

```text
Log Book is already running at http://127.0.0.1:7314
```

A second `logbook` on the same warehouse finds the first one, opens its page and ends. Nothing is wrong: use the page that is already running.

Exit code: [0, success](/reference/exit-codes#success).

### Browser not opened

```text
Browser      not opened: no xdg-open on this machine. Open http://127.0.0.1:7314 yourself, or start with logbook --no-open.
```

Log Book could not open your browser, and keeps running. Open the printed URL yourself. On a headless machine or over SSH, start with `--no-open` so it does not try:

```sh
logbook --no-open
```

## The warehouse

### The warehouse is at schema

```text
The warehouse is at schema 2; this Log Book (1.4.0) reads schema 1. Update with npm install -g @log-book/cli@latest.
```

A newer Log Book migrated the warehouse, and this one cannot read it. Update to the version the line names. To try a newer version without this happening, give it [a warehouse of its own](/start/next#give-it-a-warehouse-of-its-own).

Exit code: [6, newer warehouse](/reference/exit-codes#newer-warehouse).

### Log Book was updated while running

```text
Log Book was updated while running. Press Ctrl+C and start logbook again.
```

You installed another version while `logbook` ran, so its next sync stopped. Press Ctrl+C and start `logbook` again; the new version migrates the warehouse if it needs to.

Exit code: [9, updated while running](/reference/exit-codes#updated-while-running).

## Syncing

### No agent data found yet

```text
No agent data found yet. Log Book reads what Claude Code and OpenCode keep on this machine; it will pick them up on the next sync once either has run here.
```

Discovery found no agent's data where it looked. The lines above it say where that was, for example:

```text
Claude Code  not on this machine (no ~/.claude/projects; set CLAUDE_CONFIG_DIR if Claude Code keeps its data elsewhere)
```

Run the agent once on this machine, or set the variable the line names to where the agent keeps its data. [Environment variables](/reference/environment) lists them.

### Sync finished with

```text
Sync finished with 2 problems: Claude Code: 2 transcripts could not be read: ~/.claude/projects/shop/de30da7a-0000-4000-8000-000000000001.jsonl: unexpected end of the file
```

The sync imported what it could and could not read the rest. The lines before it name each problem. The next sync tries again. When a line says to upgrade Log Book, the agent writes a format this version does not know yet: update Log Book.

Exit code: [10, partial failure](/reference/exit-codes#partial-failure).

### sync failed, and Full output

```text
14:05 sync failed (exit 1): the warehouse file could not be opened. Full output: ~/.local/share/log-book/logs/sync-2026-10-06T14-05-00.log
```

A scheduled sync failed, and `logbook` keeps running and tries again at the next one. The log file the line names holds the sync's full output; Log Book keeps the newest 20 in `logs` inside its data directory. To see the output in your terminal, run a sync yourself:

```sh
logbook sync
```

## Locks and maintenance

Each of these lines names the process that holds the lock and the lock file. When no such process is running, it was stopped without cleaning up, and you can delete the file the line names.

### A sync is already running on this warehouse

```text
A sync is already running on this warehouse (pid 4242, lock file ~/.local/share/log-book/warehouse.db.lock). If none is running, delete that file.
```

`logbook sync`, `logbook compact` or `logbook forget` met a sync. Wait for it to end and run the command again.

Exit code: [3, already running](/reference/exit-codes#already-running).

### Maintenance is running on this warehouse

```text
Maintenance is running on this warehouse: logbook compact is rewriting it (pid 4242, lock file ~/.local/share/log-book/warehouse.db.labels.lock). Run this again once it has ended. If none is running, delete that file.
```

A sync, a labelling run or `logbook labels drop` met a compaction. A forget reads `logbook forget is removing sessions from it and rewriting it`. A labelling run that meets it stops before any model call, so it spends nothing. Meanwhile, Log Book's page shows `Compacting (since 2 min)` or `Forgetting sessions (since 2 min)` on the sync control, and the Label control reads `Labelling waits: logbook compact is rewriting the warehouse (since 2 min).` Run the command again once the maintenance has ended.

Exit code: [3, already running](/reference/exit-codes#already-running).

### Another labelling command is running on this warehouse

```text
Another labelling command is running on this warehouse, a labelling run or a logbook labels drop (pid 4242, lock file ~/.local/share/log-book/warehouse.db.labels.lock). Wait for it, or stop it where it was started. If none is running, delete that file.
```

A labelling run or `logbook labels drop` met another one. Wait for it, or stop it where it was started: Ctrl+C in its terminal, or Stop on the labelling page.

Exit code: [3, already running](/reference/exit-codes#already-running).

### A labelling command is running on this warehouse

```text
A labelling command is running on this warehouse, a labelling run or a logbook labels drop (pid 4242, lock file ~/.local/share/log-book/warehouse.db.labels.lock). Compacting rewrites the whole file: run this again once it has ended. If none is running, delete that file.
```

`logbook compact` or `logbook forget` met a labelling run or a drop, and changed nothing. Run it again once labelling has ended.

Exit code: [3, already running](/reference/exit-codes#already-running).

### Compacting, and the free disk it needs

```text
Compacting ~/.local/share/log-book/warehouse.db (1.3 GB). This rewrites the whole file and needs up to 2.6 GB of free disk; syncs and labelling wait until it ends.
```

`logbook compact` and `logbook forget` rewrite the whole warehouse, so they need free disk of up to twice its size. When the disk fills up, the command ends with SQLite's message, such as `database or disk is full`, and the warehouse stays as it was. Free some space and run it again.

Exit code on a full disk: [1, failure](/reference/exit-codes#failure).

### Compacting stopped

```text
Compacting stopped. SQLite rolled the rewrite back, so the warehouse file is unchanged: 1.3 GB, the same rows.
```

You pressed Ctrl+C during `logbook compact`, and the file is as it was. When the rewrite had already finished, the line says so instead, and the file shrinks to its new size at a later sync.

Exit code: [130, interrupted](/reference/exit-codes#interrupted).

### Forgetting stopped

```text
Forgetting stopped before anything was deleted. Nothing was forgotten, and the warehouse file is unchanged.
```

You pressed Ctrl+C during `logbook forget` before it deleted anything. When it had already deleted the sessions, they are gone, but their text may still be in the file's free space:

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

Labelling runs your own Claude Code, and Log Book found no `claude` on your `PATH`. Install Claude Code, or set `CLAUDE_BIN` to the `claude` you use. When the line says `needs Claude Code 2.1.286 or newer`, update it:

```sh
claude update
```

Exit code: [7, missing prerequisite](/reference/exit-codes#missing-prerequisite).

### Claude Code is not signed in

```text
Claude Code is not signed in. Run claude, sign in, then run this again.
```

Labelling runs `claude` signed in as you. Run `claude`, sign in, and start labelling again.

Exit code: [7, missing prerequisite](/reference/exit-codes#missing-prerequisite).

### --model must start with a letter or digit

```text
--model must start with a letter or digit and hold only letters, digits, . _ - : or @ (at most 128 characters), got "claude haiku"
```

The model id has a character a model id cannot hold. Pass a full model id, such as `claude-sonnet-5-5`:

```sh
logbook labels update --model claude-sonnet-5-5
```

Exit code: [2, usage error](/reference/exit-codes#usage-error).

### Labelling failed on

```text
Labelling failed on claude-example-1: <what Claude Code said>. 0 of 2,214 records labelled and kept. Run the same command again once fixed, for example with another --model.
```

Claude Code refused the run, for example because your plan or provider does not offer the model you passed. Log Book keeps no list of models, so it learns this from the first request. Run it again with a model your plan offers.

Exit code: [1, failure](/reference/exit-codes#failure).

### Stopped at your Claude usage limit

```text
Stopped at your Claude usage limit (Example limit reached, resets at 5pm). 1,240 of 2,214 records labelled and kept. Run the same command again once the limit resets.
```

Labelling counts against your Claude plan like your own sessions, and the plan's limit was reached. Every finished batch is kept. Run the same command again once the limit resets, and it continues where it stopped.

Exit code: [8, usage limit](/reference/exit-codes#usage-limit).

### Labelling stopped: Claude Code could not reach its API

```text
Labelling stopped: Claude Code could not reach its API (No response from API). 1,240 of 2,214 records labelled and kept. Run the same command again when you are online.
```

Claude Code could not connect. Every finished batch is kept. Run the same command again when you are online.

Exit code: [1, failure](/reference/exit-codes#failure).

## Reporting a problem

When nothing here helps, open an issue on [GitHub](https://github.com/developer239/logbook/issues) and paste what `logbook doctor` prints, with the message you met:

```sh
logbook doctor
```

It prints the versions, the warehouse, where each agent keeps its data and whether labelling can run, and nothing of your sessions.
