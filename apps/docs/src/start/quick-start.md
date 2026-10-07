# Quick start

::: info Before you install

- Log Book reads the Claude Code and OpenCode history already stored on this machine, and changes none of it.
- It runs on macOS and Linux, arm64 or x64, with Node.js <Fact name="nodeFloor" /> or newer. On Windows, run it inside WSL 2.
- It imports your history into a local SQLite file and serves its page on `127.0.0.1`. Syncing and the page never use the network.
- Optional [model labelling](/labelling/) sends unredacted excerpts through your own signed-in Claude Code, and counts against your Claude plan. It never starts on its own.
- It is free for noncommercial use. Company use needs a [separate license](/help/license).

:::

## Try it

Run the latest release once, without installing anything:

<InstallCommand variant="npx" />

Or install the `logbook` command:

<InstallCommand />

Both keep their data in the same place, so you can switch between them. pnpm works too: `pnpm add -g @log-book/cli`.

## The first run

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

Log Book imports your history into `warehouse.db`, creating it on the first run, and opens the page in your browser. The Claude Code and OpenCode lines say where it found each agent's data; when one is missing, the line names the variable that points Log Book elsewhere. After the first sync it syncs again every five minutes while it runs, and prints a line only when a sync imports something or meets a problem.

The Labelling line says whether model labelling can run. Without Claude Code, everything else works the same, and the cards that need model labels say so.

If neither agent has run on this machine yet, Log Book starts anyway and picks their data up at a later sync.

## Your first five minutes

None of this needs model labels.

1. On the dashboard, open **Calls that went wrong** to see every failed step in the range.
2. Open one to jump to its turn in the conversation, with the tool's input and output already open.
3. Back in a terminal, find how you fixed something before:

   ```sh
   logbook search '"the error text"'
   ```

4. Print the failure reports as tables:

   ```sh
   logbook report failures --max-rows 20
   ```

[Tour the product](/tour) shows the rest of the page, and [CLI recipes](/reference/recipes) the rest of the commands.

## Your history from now on

Claude Code deletes its old transcripts after its cleanup period: 30 days, unless you changed `cleanupPeriodDays`. Log Book keeps every session it imported, so from your first run on, your history outlives the transcripts.

## Where it looks

Log Book reads each agent's data where the agent keeps it:

- **Claude Code:** `~/.claude/projects`, or `projects` inside `CLAUDE_CONFIG_DIR` when you set it.
- **OpenCode:** its database under `~/.local/share/opencode`, or where `OPENCODE_DB`, `OPENCODE_DISABLE_CHANNEL_DB` or `XDG_DATA_HOME` move it.

[Environment variables](/reference/environment) lists every variable.

## Options

On a headless machine or over SSH, start it with `--no-open` and open the printed URL yourself, through a forwarded port if you need to:

```sh
logbook --no-open --port 7400
```

<!--@include: ../.generated/start-options.md-->

To stop it, press Ctrl+C. A sync in progress finishes its current step first; a second Ctrl+C stops at once.

## Requirements in detail

- **Node.js <Fact name="nodeFloor" /> or newer**, for its built-in SQLite. On an older Node.js, `logbook` stops before it starts:

  ```text
  Log Book needs Node.js <floor> or newer; this is Node.js <version> at <path>. Install Node.js <floor> (https://nodejs.org) or switch to it with your version manager, then run logbook again.
  ```

- **macOS or Linux.** On Windows, npm refuses the install with `EBADPLATFORM`; run Log Book inside WSL 2, where your agents run.

### If npm install -g fails with EACCES

On Linux with the Node.js your distribution packages, the directory npm installs global packages into belongs to root. Install Node.js with a version manager such as nvm, fnm, mise or Volta, which keeps it in your home directory, or give npm a global directory of your own:

```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
```

Then add `~/.npm-global/bin` to your `PATH`, open a new terminal and install again.

Do not install as root. A `logbook` run as root reads root's home directory, finds none of your agents' data, and writes a data directory only root can change.

### On a shared machine

While `logbook` runs, any user of the machine can open its page at `127.0.0.1` on its port, as with any local server, and the page has no login. The warehouse file itself can be read only by you.

## Check what Log Book finds

```sh
logbook doctor
```

It prints the versions, the warehouse and its size, where each agent keeps its data and whether labelling can run, and changes nothing. It holds no session, prompt or project name, so paste it into a bug report as it is. [Troubleshooting](/help/troubleshooting#reporting-a-problem) shows an example.
