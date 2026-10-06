Log Book shows where your coding agent's time went, from the sessions Claude Code and OpenCode already keep on your machine.

[![The Log Book dashboard in the dark scheme](https://developer239.github.io/logbook/captures/dashboard-dark.png)](https://developer239.github.io/logbook/)

## Install

```sh
npm install -g @log-book/cli
logbook
```

Log Book needs Node.js 24.15 or newer on macOS or Linux; on Windows, run it inside WSL.

## What Log Book sends, and where

<!-- statement:start -->

Log Book runs on your computer. It reads the session files your coding agents already keep, copies them into one database file in your user data folder, and shows them on a page served from your own computer at 127.0.0.1. It has no account, no server of its own, no telemetry, no crash reporting and no update check, and it downloads nothing while it runs.

<!-- data-flow-case: labelling -->

Data leaves your computer in one case only, and only when you start it: model labelling.

<!-- data-flow-case: labelling -->

**Model labelling, when you run it.** Labelling a reaction, a session's goal or a failed command needs a model. When you start labelling (`logbook labels update` in a terminal, or Label and then Start in Log Book's page), Log Book runs your own Claude Code once for each batch of records, as `claude -p`, on the model you choose (Claude Haiku unless you pick another). Each run sends excerpts of your sessions to Anthropic, or to the provider your Claude Code is set up to use, under your Claude Code login, and counts against your Claude plan's usage limits like your own sessions do. The excerpts are listed in [the table of what each request contains](https://developer239.github.io/logbook/labelling/what-it-sends#what-each-request-contains): for example the start of a failed command and the end of its output, the first prompts of a session, or a prompt with the steps and reply before it. They come from every agent Log Book reads, including sessions you ran with other providers. Nothing in them is removed or hidden: if a command printed a secret inside an excerpt, the secret is sent. With them go Log Book's fixed instructions for the task, and a few lines Claude Code adds to every request of its own accord: its version, the temporary folder it runs in, your platform, shell and operating system version, today's date, and the email address and id of the Claude account it is logged in with. Log Book never sees your Claude login: Claude Code signs in by itself. Claude Code keeps no history of these runs, and Log Book asks it, on every run including the version and login checks before labelling, to send nothing else of its own. If your organisation manages your Claude Code, its managed settings still apply to these runs, including any hooks they define; Log Book cannot turn those off. Before the first request, Log Book shows the model, how many records of each agent it will send and an estimate of the tokens; you can preview the exact text of any batch first, and stop at any time.

<!-- data-flow-case: local -->

Nothing else leaves. Syncing reads files on your disk. The page loads nothing from the internet. Labels that need no model are made on your computer on every sync.

<!-- statement:end -->

## License

Log Book is free. Its source is public under the PolyForm Noncommercial License 1.0.0, which makes it source-available rather than open source: you can use it, read it and change it for personal projects, study and research, and charities, schools and public bodies can use it too. Using it at work for a company needs a separate license; write to m.jarnot@yahoo.com.

[The license and what it allows](https://developer239.github.io/logbook/help/license)

## Links

- [Documentation](https://developer239.github.io/logbook/)
- [Releases](https://github.com/developer239/logbook/releases)
- [Issues](https://github.com/developer239/logbook/issues)
