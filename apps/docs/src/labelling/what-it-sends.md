# What it sends

## What each request contains

Each request holds a batch of items, and each item holds these parts of a record, in this order, each cut to its clip size. Excerpts are not redacted.

<!--@include: ../.generated/item-contents.md-->

## What goes with every request

With the items go the task's one-line system text and its fixed instructions, about 1 to 4 KB per task. Claude Code adds lines of its own accord: its version, the temporary folder it runs in, your platform, shell and operating system version, today's date, and the email address and id of the Claude account.

## Before the first request

Before the first request, Log Book shows the model, the records per task and per agent, and an estimate of the tokens. The same plan prints as one JSON object, without calling a model:

```sh
logbook labels plan
```

## Preview a batch

`logbook labels preview --task <task> [--batches <n>]` prints the next batches of a task exactly as labelling would send them, and starts no `claude`. For example:

```sh
logbook labels preview --task shell
```

prints, with the task's instructions and items in place of the lines in angle brackets:

```text
Preview of task shell: the next 1 batch, 16 records, exactly as labelling would send it now. Nothing is sent.

System line (passed to claude as --system-prompt):
You label shell commands for a telemetry analysis. Answer only with the requested lines.

Batch 1 of 1 (sent on the stdin of one claude -p call, 16 records):
<the task's instructions, then the 16 items>

Claude Code adds framing of its own to each request (its version, the folder it runs in, your platform, the date and the account it is logged in with), which Log Book does not see and so cannot show.
```

## Cost per 1,000 records

Measured with Claude Code 2.1.286 on one developer's warehouse, with the model each figure was measured with. Claude Code adds about 440 input tokens of its own framing to every call. The four Sonnet rows have no Haiku measurement, because a token count depends on the model's tokenizer. These calls count against your Claude plan like your own sessions.

| Task           | Measured with       | Calls per 1,000 records                                        | Input tokens per 1,000 records | Output tokens per 1,000 records               | Time per 1,000 records (4 at once) |
| -------------- | ------------------- | -------------------------------------------------------------- | ------------------------------ | --------------------------------------------- | ---------------------------------- |
| `shell`        | `claude-haiku-4-5`  | 40                                                             | 150,000 to 250,000             | 7,000                                         | under a minute                     |
| `tool-failure` | `claude-haiku-4-5`  | 1 per 25 records the rules leave open (about 1 failure in 200) | about 330 per record           | small                                         | seconds                            |
| `session`      | `claude-sonnet-5-5` | 50                                                             | 530,000                        | 27,000                                        | about a minute and a half          |
| `outcome`      | `claude-sonnet-5-5` | 50                                                             | 510,000                        | not recorded; of the order of the goal task's | about a minute and a half          |
| `prompt`       | `claude-sonnet-5-5` | 125                                                            | 1,800,000                      | 40,000                                        | about 3.5 minutes                  |
| `reply`        | `claude-sonnet-5-5` | 125                                                            | 1,700,000                      | not recorded                                  | about 2.5 minutes                  |
