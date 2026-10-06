See where your coding agent's time went, from the sessions data Claude Code and OpenCode already keep on your device.

[![CI](https://github.com/developer239/logbook/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/developer239/logbook/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@log-book/cli?label=npm&color=cb3837)](https://www.npmjs.com/package/@log-book/cli)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2024.15-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](https://developer239.github.io/logbook/start/install)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](https://developer239.github.io/logbook/help/license)
[![Docs](https://img.shields.io/badge/docs-read-0a7ea4)](https://developer239.github.io/logbook/)

**[Read the documentation](https://developer239.github.io/logbook/)**

## Install

```sh
npm install -g @log-book/cli
logbook
```

Calling `logbook` automatically syncs your sessions and opens the dashboard at `http://127.0.0.1:7314`. It needs Node.js 24.15 or newer on macOS or Linux; on Windows, run it inside WSL.

## What you get

- **Every conversation:** the whole thread with its steps, subagents and tokens, from both agents in one list and their tool calls.
- **Tool problems:** failed calls by cause, retry loops, and calls that ran far longer than usual.
- **Reactions:** how often you corrected the agent, pushed back or praised it, and how each model's replies react to you.
- **Time per turn:** model time, tool time, and the time the agent waited for you.
- **Goals and outcomes:** what each conversation was for, and whether it got done.

## Privacy

Everything stays on your computer: no account, no server, no telemetry. Data leaves only when you start labelling, which runs your own Claude Code on the model you choose and sends excerpts of your sessions under your own login. [What Log Book sends, and where](https://developer239.github.io/logbook/privacy/)

## License

Free for personal projects, study, research, charities, schools and public bodies, under the PolyForm Noncommercial License 1.0.0. Using it at work for a company needs a separate license: write to m.jarnot@yahoo.com. [The license in plain words](https://developer239.github.io/logbook/help/license)

## Links

- [Documentation](https://developer239.github.io/logbook/)
- [Releases](https://github.com/developer239/logbook/releases)
- [Issues](https://github.com/developer239/logbook/issues)
