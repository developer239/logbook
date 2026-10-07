Find the slow turns, failed tools and repeated mistakes in your Claude Code and OpenCode history.

[![CI](https://github.com/developer239/logbook/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/developer239/logbook/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@log-book/cli?label=npm&color=cb3837)](https://www.npmjs.com/package/@log-book/cli)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2024.15-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](https://developer239.github.io/logbook/start/quick-start)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](https://developer239.github.io/logbook/help/license)
[![Docs](https://img.shields.io/badge/docs-read-0a7ea4)](https://developer239.github.io/logbook/)

Log Book reads the sessions your coding agents already keep on this machine and shows them on a page your own computer serves. Every number on it opens the conversations and tool calls behind it.

**[Read the documentation](https://developer239.github.io/logbook/)**

## Try it

```sh
npx @log-book/cli
```

Or install the `logbook` command:

```sh
npm install -g @log-book/cli
logbook
```

The first run imports your history, about half a minute per thousand sessions, and opens `http://127.0.0.1:7314`. While it runs, it syncs again every five minutes.

## Before you install

- It needs Node.js 24.15 or newer on macOS or Linux; on Windows, run it inside WSL 2.
- It reads Claude Code and OpenCode history.
- Syncing and the page stay on your computer: no account, no server of its own, no telemetry.
- Optional model labelling sends unredacted session excerpts through your own Claude Code, and counts against your Claude plan. It never starts on its own, and you can preview what it would send.
- It is free for noncommercial use. Company use needs a license.

## What you can find

- Failed tool calls by cause, retry loops, and calls that ran far longer than usual.
- How long each turn took, split into model time, tool time and idle.
- Every conversation with its steps, subagents and tokens, from both agents in one list.
- Which tools put the most text into the model's context.
- With model labels: what each conversation was for, how it ended, and how you and the agent reacted to each other.

## Ask it from the terminal, or let your agent ask

```sh
logbook search '"connection refused"'
logbook report failures --max-rows 20
logbook sql "SELECT COUNT(*) FROM session"
```

`logbook sql` is read-only, and its help lists every table, so Claude Code or OpenCode can answer questions about your past work from it. What a command prints becomes part of that agent's conversation, and reaches its model provider like anything else it reads. [CLI recipes](https://developer239.github.io/logbook/reference/recipes)

## Privacy

Log Book copies your agents' history into a SQLite file in your home directory and serves its page on `127.0.0.1`; syncing never uses the network. The one exception is model labelling, when you start it. [Privacy and security](https://developer239.github.io/logbook/privacy/)

## License

Free for personal projects, study, research, charities, schools and public bodies, under the PolyForm Noncommercial License 1.0.0. Using it at work for a company needs a license: write to [m.jarnot@yahoo.com](mailto:m.jarnot@yahoo.com). [License and company use](https://developer239.github.io/logbook/help/license)

## Links

- [Documentation](https://developer239.github.io/logbook/)
- [Releases](https://github.com/developer239/logbook/releases)
- [Issues](https://github.com/developer239/logbook/issues)
