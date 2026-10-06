# The first run

Start Log Book:

```sh
logbook
```

## What it prints

```text
Log Book <version>
Warehouse    ~/.local/share/log-book/warehouse.db, created at schema 1
Claude Code  found at ~/.claude/projects
OpenCode     not on this machine (no ~/.local/share/opencode/opencode.db; set OPENCODE_DB if OpenCode keeps its data elsewhere)

Log Book is running at http://127.0.0.1:7314
Press Ctrl+C to stop.

First sync   reading your whole history (about half a minute per thousand sessions)
Labelling    ready: claude <version>, signed in with a Claude subscription; default model claude-haiku-4-5
First sync   done in 41 s: 1284 sessions. Next sync in 5 minutes.
```

- **Warehouse** is the file Log Book keeps everything in. On the first run it is created; after an update it is migrated forward.
- **Claude Code** and **OpenCode** are the agents Log Book reads. Each line says where it found the agent's data, or where it looked and which variable points it elsewhere.
- **The URL** is the page Log Book serves, on `127.0.0.1` only.
- **First sync** reads every session your agents kept into the warehouse. While it runs, a progress line per agent counts the transcripts or sessions it has read.
- **Labelling** says whether Log Book can label your sessions with a model. Labelling runs your own `claude`, so this line names its version and how it is signed in. Without it, Log Book works the same and the cards that need model labels say so. When `claude` is missing, the line says what to do:

  ```text
  Labelling    needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN
  ```

When no agent's data is found, Log Book says so and starts anyway, and picks the data up at a later sync:

```text
No agent data found yet. Log Book reads what Claude Code and OpenCode keep on this machine; it will pick them up on the next sync once either has run here.
```

## Where it looks

Log Book reads each agent's data where the agent keeps it, and changes none of it:

- **Claude Code:** `~/.claude/projects`, or `projects` inside `CLAUDE_CONFIG_DIR` when you set it.
- **OpenCode:** its database under `~/.local/share/opencode`, or where `OPENCODE_DB`, `OPENCODE_DISABLE_CHANNEL_DB` or `XDG_DATA_HOME` move it, the way OpenCode reads them.

[Environment variables](/reference/environment) lists every variable and what it changes.

## The first sync and the schedule

The first sync reads your whole history, about half a minute per thousand sessions. After it, Log Book syncs every five minutes while it runs, and a scheduled sync prints a line only when it imports something or meets a problem.

## Options

Log Book opens its page in your browser. On a headless machine or over SSH, start it with `--no-open` and open the printed URL yourself, through a forwarded port if you need to.

```sh
logbook --no-open --port 7400
```

<!--@include: ../.generated/start-options.md-->

## Stop it

Press Ctrl+C. When a sync is running, Log Book waits for it to finish its current step:

```text
Stopping (waiting for the sync to finish its current step)...
```

A second Ctrl+C stops it at once.

## Your history from now on

Claude Code deletes its old transcripts after its cleanup period: 30 days, unless you changed `cleanupPeriodDays`. Log Book keeps every session it imported, so from your first run on, it keeps your history after Claude Code has deleted the transcripts.
