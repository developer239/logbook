# Labels

Log Book works without a model. Rules label what they can on every sync, on your computer; optional model labels add what a conversation was for, how it ended, and how you and the agent reacted to each other. A model run never starts on its own.

## What works without a model

On every sync, rules label:

- what a shell call was for, such as running tests or installing packages;
- why a failed call failed, for the tools other than the shell;
- whether the agent recovered after a failed call;
- who started a session: you, or an agent.

So failures, retry loops, slow calls, timing, tokens and every conversation work from the first sync. The cards that need a model say so until you label:

<Shot id="not-labelled" caption="The dashboard before any model labels: the cards that need them say so." />

## What labels add

A run has six tasks, each feeding its cards:

| Task           | Labels                                                                   | Feeds                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shell`        | What each shell call was for, and why a failed one failed                | <Ui page="/">Tool problems</Ui>, <Ui page="/">Unusually slow calls</Ui>, <Ui page="/">Calls that went wrong</Ui>                                             |
| `tool-failure` | Why a failed call of another tool failed, where the rules could not tell | <Ui page="/">Tool problems</Ui>, <Ui page="/">Calls that went wrong</Ui>                                                                                     |
| `session`      | What each conversation was for                                           | <Ui page="/">Conversations by goal</Ui>, <Ui page="/">Tokens per conversation</Ui>, <Ui page="/">Time per turn</Ui>, <Ui page="/">Time per conversation</Ui> |
| `outcome`      | How each conversation ended, with a note                                 | <Ui page="/">Finished</Ui>, <Ui page="/">Didn't finish</Ui>                                                                                                  |
| `prompt`       | What each of your prompts did, and how you reacted to the agent          | <Ui page="/">Reactions to the agent</Ui>                                                                                                                     |
| `reply`        | How the agent's last reply before your next prompt treated you           | <Ui page="/">Reactions from the agent</Ui>                                                                                                                   |

A conversation's goal is one of the goals a model chooses from, such as `build a feature`, `fix a bug`, `review` and `explore the codebase`. Its outcome is `done`, `partly done`, `handed off`, `blocked`, `failed`, `abandoned`, `no task` or `unclear`.

Labelled, the reaction cards show how you and the agent dealt with each other, week by week:

<Shot id="reactions-card" caption="Your corrections, pushback and praise, as shares of your prompts." />

<Shot id="agent-reactions" caption="How often each model's replies asked permission, gave in, or pushed back." />

## Preview, then start a run

See what a run would send before it sends anything. The plan prints the model, the records per task and per agent, and an estimate of the tokens; a preview prints the exact text of a task's next batches:

```sh
logbook labels plan
logbook labels preview --task shell
```

Then start it, in a terminal or with <Ui page="/">Label</Ui> in the top bar, which opens a page with the same plan and a Start labelling button:

```sh
logbook labels update
```

A run labels through your own Claude Code: it starts `claude -p` once per batch, signed in as you, so the requests count against your Claude plan like your own sessions. Before it starts, it says which `claude` it uses, how it is signed in and which model it runs on. When `ANTHROPIC_API_KEY` is set, it warns that Claude Code may bill the run to that key instead of your plan. Log Book does not support local models.

[Privacy and security](/privacy/) says exactly what each request holds.

## Choose a model

One model labels a whole run: the one you pass with `--model`, or Claude Haiku (<Fact name="defaultModel" />) when you pass none. Haiku is the cheapest, and its labels are less reliable:

<!--@include: ../.generated/model-option.md-->

So with Haiku, the praise line of <Ui page="/">Reactions to the agent</Ui> reads lower than Sonnet's labels would make it. To choose another model, pass its full id, not an alias such as `sonnet`:

```sh
logbook labels update --model claude-sonnet-5-5
```

Log Book remembers no choice. A later `logbook labels update` with another model labels only the records no model has labelled yet.

## What a run costs

Measured on one warehouse with Claude Code 2.1.286; treat the figures as examples, not estimates for your data. Claude Code adds about 440 input tokens of its own framing to every call. The calls count against your Claude plan like your own sessions.

| Task           | Measured with       | Calls per 1,000 records                                        | Input tokens per 1,000 records | Output tokens per 1,000 records | Time per 1,000 records (4 at once) |
| -------------- | ------------------- | -------------------------------------------------------------- | ------------------------------ | ------------------------------- | ---------------------------------- |
| `shell`        | `claude-haiku-4-5`  | 40                                                             | 150,000 to 250,000             | 7,000                           | under a minute                     |
| `tool-failure` | `claude-haiku-4-5`  | 1 per 25 records the rules leave open (about 1 failure in 200) | about 330 per record           | small                           | seconds                            |
| `session`      | `claude-sonnet-5-5` | 50                                                             | 530,000                        | 27,000                          | about a minute and a half          |
| `outcome`      | `claude-sonnet-5-5` | 50                                                             | 510,000                        | not measured                    | about a minute and a half          |
| `prompt`       | `claude-sonnet-5-5` | 125                                                            | 1,800,000                      | 40,000                          | about 3.5 minutes                  |
| `reply`        | `claude-sonnet-5-5` | 125                                                            | 1,700,000                      | not measured                    | about 2.5 minutes                  |

The Sonnet rows have no Haiku figure, because a token count depends on the model's tokenizer.

## Stop and resume

A run keeps every batch it finished, however it stops: Ctrl+C, Stop on the labelling page, stopping `logbook`, your Claude usage limit, or a killed process. Run the same command again to continue where it stopped.

A session's outcome and its last reply wait until the session has been quiet for an hour, so a run does not label a conversation that is still going.

## Compare two models

To see how another model labels what you already have, label one task again with it, compare the two, and drop the labels you do not keep:

```sh
logbook labels run --task prompt --model claude-sonnet-5-5
logbook labels compare --task prompt --first claude-haiku-4-5 --second claude-sonnet-5-5
logbook labels drop --task prompt --labeller claude-haiku-4-5
```

`logbook labels compare` prints how often the two agree, field by field, and their most common disagreements. Reports read each record's newest model label, so drop the labeller you did not choose.
