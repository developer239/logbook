# Install

<InstallCommand />

The first line installs the `logbook` command, and the second starts Log Book. The [first run](/start/first-run) page walks through what it prints.

## Requirements

- Node.js <Fact name="nodeFloor" /> or newer. From that version on, Node.js loads `node:sqlite`, which Log Book's warehouse needs, without a flag, with full-text search and without printing an experimental-feature warning. On an older Node.js, `logbook` stops before it starts and prints:

  ```text
  Log Book needs Node.js <floor> or newer; this is Node.js <version> at <path>. Install Node.js <floor> (https://nodejs.org) or switch to it with your version manager, then run logbook again.
  ```

- macOS or Linux, on arm64 or x64. WSL 2 counts as Linux.
- Windows is not supported. npm refuses the install with `EBADPLATFORM`, and a `logbook` that was installed anyway stops at start with:

  ```text
  Log Book runs on macOS and Linux. On Windows, run it inside WSL, where your agents run.
  ```

## Install it or run it once

The global install puts `logbook` on your `PATH`, so you start it with one word from then on. To run the latest release once without installing it, use npx instead:

<InstallCommand variant="npx" />

npx keeps a copy in its cache, so the next run starts without a download. Either way, Log Book keeps its data in the same place, so you can switch between the two.

## If npm install -g fails with EACCES

On Linux with the Node.js your distribution packages, the global install fails with `EACCES`: the directory npm installs global packages into belongs to root. Fix it in one of two ways:

- Install Node.js with a version manager, such as nvm, fnm, mise or Volta. It keeps Node.js and its global packages in your home directory.
- Or give npm a global directory of your own:

  ```sh
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  ```

  Then add `~/.npm-global/bin` to your `PATH` in your shell's profile, open a new terminal and install again.

Do not install with root's rights. A `logbook` run as root reads root's home directory instead of yours, finds none of your agents' data and writes a data directory that only root can change.

## pnpm

pnpm works too:

```sh
pnpm add -g @log-book/cli
```

## On a shared machine

While `logbook` runs, any user of the machine can open its page at `127.0.0.1` on its port, as with any local server. The warehouse file itself can be read only by you.

## Check what Log Book finds

`logbook doctor` prints what Log Book finds on this machine and changes nothing:

```sh
logbook doctor
```

It prints the versions, the warehouse, where each agent keeps its data and whether labelling can run, for example:

```text
Log Book <version>, Node.js <version>, linux x64
Warehouse   ~/.local/share/log-book/warehouse.db (schema 1, 261 MB; no host running)
Claude Code found at ~/.claude/projects
OpenCode    not on this machine (no ~/.local/share/opencode/opencode.db; set OPENCODE_DB if OpenCode keeps its data elsewhere)
Labelling   needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN
```

When you report a bug, paste what it prints. It holds no session, prompt or project name.
