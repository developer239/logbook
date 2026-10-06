---
layout: home

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

## Who it is for

You use Claude Code or OpenCode most days, and the sessions blur together. You'd like to know where the waiting comes from, whether the same command fails every week, and how often you have to correct the agent. Log Book answers from the history already on your disk. You don't change how you work, and there is nothing to configure.

## See it

<Shot id="conversation" caption="One conversation, with the steps of the turn you are reading." />

<Shot id="agent-reactions" caption="How each model's replies react to you: asking permission, giving in, pushing back." />

<Video id="tour" />

A short tour: the dashboard, one conversation as you scroll through it, and the reactions on both sides. It plays when you click it, without sound.

## Install

<InstallCommand />

`logbook` opens `http://127.0.0.1:<Fact name="defaultPort" />` in your browser. You need Node.js <Fact name="nodeFloor" /> or newer on macOS or Linux; on Windows, run it inside WSL. The first sync reads your whole history, about half a minute per thousand sessions, and Log Book syncs again every five minutes while it runs. To try it without installing anything, run `npx @log-book/cli`.

## Your data stays on your computer

<!--@include: ./privacy/summary.md-->

## Free for noncommercial use

Log Book is free. Its source is public under the PolyForm Noncommercial License 1.0.0, which makes it source-available rather than open source: you can use it, read it and change it for personal projects, study and research, and charities, schools and public bodies can use it too. Using it at work for a company needs a separate license; write to m.jarnot@yahoo.com.

[The license in plain words](/help/license)
