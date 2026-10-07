Log Book runs on your computer. It reads the session files your coding agents already keep, copies them into one database file in your user data folder, and shows them on a page served from your own computer at 127.0.0.1. It has no account, no server of its own, no telemetry, no crash reporting and no update check.

<!-- data-flow-case: local -->

Syncing reads files on your disk, the page loads nothing from the internet, and the labels that need no model are made on your computer on every sync. None of that uses the network.

<!-- data-flow-case: labelling -->

**Model labelling is the one exception, and it runs only when you start it**, with `logbook labels update` in a terminal or Label and then Start on Log Book's page. Log Book then runs your own Claude Code once per batch of records, as `claude -p`, on the model you choose (Claude Haiku unless you pick another). Each run sends excerpts of your sessions to Anthropic, or to the provider your Claude Code is set up to use, under your Claude Code login, and counts against your Claude plan's usage limits like your own sessions.

The excerpts are unredacted. They include, for example, the start of a failed command and the end of its output, the first prompts of a session, or a prompt with the steps and reply before it, from every agent Log Book reads, including sessions you ran with other providers. If a command printed a secret inside an excerpt, the secret is sent. [What each request contains](/privacy/#what-each-request-contains) lists every part and its size.

With the excerpts go Log Book's fixed instructions for the task, and a few lines Claude Code adds to every request itself: its version, the temporary folder it runs in, your platform, shell and operating system version, today's date, and the email address and id of the Claude account it is logged in with.

Before the first request, Log Book shows the model, how many records of each agent it will send and an estimate of the tokens. You can preview the exact text of any batch with `logbook labels preview`, and stop a run at any time.

Log Book never sees your Claude login: Claude Code signs in by itself. Claude Code keeps no history of these runs, and Log Book asks it, on every run including the version and login checks before labelling, to send nothing else of its own. If your organisation manages your Claude Code, its managed settings still apply to these runs, including any hooks they define, and Log Book cannot turn those off.
