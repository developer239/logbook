---
layout: home
# The hook home.css styles the hero by.
pageClass: home-page

hero:
  name: Log Book
  text: Find the slow turns, failed tools and repeated mistakes.
  tagline: Log Book reads the sessions Claude Code and OpenCode already keep on your machine, and shows them on a page your own computer serves.
  image:
    dark: /captures/dashboard-dark.png
    light: /captures/dashboard-light.png
    alt: The Log Book dashboard
  actions:
    - theme: brand
      text: Install
      link: '#install'
    - theme: alt
      text: Quick start
      link: /start/quick-start
    - theme: alt
      text: Source on GitHub
      link: https://github.com/developer239/logbook

features:
  - title: 1. Spot the pattern.
    details: Failed calls, retry loops, slow turns and unfinished conversations, across Claude Code and OpenCode, week by week.
    link: /tour#spot-a-pattern-on-the-dashboard
    linkText: The dashboard
  - title: 2. Open the evidence.
    details: Every number opens the conversations and tool calls behind it, down to the exact turn and its output.
    link: /tour#open-the-evidence-behind-a-number
    linkText: Drill down
  - title: 3. Ask your history.
    details: Search past work from the terminal, run a report, or let your coding agent query it for you.
    link: /reference/recipes
    linkText: CLI recipes
---

## Install

<InstallCommand />

`logbook` opens <code><Fact name="defaultAddress" /></code> in your browser. The first sync reads your whole history, about half a minute per thousand sessions, and Log Book syncs again every five minutes while it runs. To try it without installing anything, run `npx @log-book/cli`.

::: info Before you install

- It reads the Claude Code and OpenCode history already stored on this machine.
- It runs on macOS and Linux with Node.js <Fact name="nodeFloor" /> or newer; on Windows, inside WSL 2.
- The page is served on `127.0.0.1`, and your history is copied into a SQLite file in your home directory.
- Syncing and everything you see without labels stay on your computer. Optional model labelling sends session excerpts through your own Claude Code.
- It is free for noncommercial use. [Company use](/help/license) needs a license.

:::

## Useful from the first sync

Without any model, Log Book shows every conversation, failed tool calls by cause, retry loops, slow calls, turn timing and token use.

Model labels add what each conversation was for, how it ended, and how you and the agent reacted to each other. You start them yourself, [preview](/labelling/#preview-then-start-a-run) what they would send, and choose the Claude model; they count against your Claude plan.

## Search your past work from the terminal

Everything the page shows is also a `logbook` command, so you, a script or your coding agent can ask it directly:

```sh
logbook search '"connection refused"'   # prompts, replies, reasoning and tool output that hold it
logbook report failures                 # what kept failing, by tool and by cause
logbook sql "SELECT COUNT(*) FROM session"   # read-only SQL over your history
```

Ask Claude Code "what kept failing last week?" and it can run these and answer from your history. `logbook sql --help` describes every table, so an agent can write its own queries. [CLI recipes](/reference/recipes)

## See it

<Video id="tour" />

## Your data stays on your computer

<!--@include: ./privacy/summary.md-->
