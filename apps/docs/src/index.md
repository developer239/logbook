---
layout: home
# The hook home.css styles the hero by.
pageClass: home-page

hero:
  name: Log Book
  text: Where your coding agent's time went.
  tagline: Log Book reads the sessions Claude Code and OpenCode already keep on your machine and shows them on a page your own computer serves. See which turns were slow and why, which tool calls failed, and which corrections you keep making.
  image:
    dark: /captures/dashboard-dark.png
    light: /captures/dashboard-light.png
    alt: The Log Book dashboard
  actions:
    - theme: brand
      text: Install
      link: '#install'
    - theme: alt
      text: Read the docs
      link: /start/install
    - theme: alt
      text: Source on GitHub
      link: https://github.com/developer239/logbook

features:
  - title: Time per turn.
    details: How long each turn took, split into model time, tool time and time the agent spent waiting for you.
  - title: Tool problems.
    details: Failed calls grouped by cause, retry loops, and calls that ran far longer than usual.
  - title: Your reactions.
    details: How often you corrected the agent, pushed back or praised it, week by week.
  - title: The agent's reactions.
    details: For each model, how often its replies ask your permission, give in when you push back, or push back themselves.
  - title: Goals and outcomes.
    details: What each conversation was for, and whether it got done, stalled or was abandoned.
  - title: Every conversation.
    details: The whole thread with each step, subagent and token count, from both agents in one list.
---

Reactions, goals and outcomes come from [labelling](/labelling/), which runs only when you start it, through your own Claude Code, on the model you choose (<Fact name="defaultModel" /> unless you pick another).

## Install

<InstallCommand />

`logbook` opens <code><Fact name="defaultAddress" /></code> in your browser. You need Node.js <Fact name="nodeFloor" /> or newer on macOS or Linux; on Windows, run it inside WSL. The first sync reads your whole history, about half a minute per thousand sessions, and Log Book syncs again every five minutes while it runs. To try it without installing anything, run `npx @log-book/cli`.

## Ask it from the terminal, or let your agent ask

Everything the page shows is also a `logbook` command, so you, a script or your coding agent can ask it directly:

```sh
logbook sessions --limit 10   # the newest sessions
logbook search "flaky test"   # prompts, replies, reasoning and tool output that mention it
logbook report                # every canned report
logbook sql "SELECT COUNT(*) FROM session"   # read-only SQL over the warehouse
```

Ask Claude Code or OpenCode a question about your past work, such as what kept failing last week or how you fixed a problem before, and it can run these and answer from your history. `logbook sql --help` describes every table, so an agent can write its own queries. What a command prints becomes part of that agent's conversation, so it reaches the agent's model provider like anything else the agent reads. [Every command](/reference/cli)

## See it

<Video id="tour" />

## Your data stays on your computer

<!--@include: ./privacy/summary.md-->
