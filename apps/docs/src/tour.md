# Tour the product

Log Book's page goes from a pattern to its evidence: the dashboard shows where time and failures pile up, every number opens the steps or conversations behind it, and a conversation shows the exact turn where it went wrong.

## Spot a pattern on the dashboard

<Shot id="dashboard" caption="The dashboard over 30 days of the demo's data." />

The top bar sets the range every page shows: <Ui page="/">Today</Ui>, <Ui page="/">7 days</Ui> (where Log Book starts), <Ui page="/">30 days</Ui>, <Ui page="/">All</Ui>, or a <Ui page="/">Custom</Ui> span of days. The four figures at the top compare the range with the one before it.

The cards fall into three groups:

- **Failures:** <Ui page="/">Tool problems</Ui> groups failed calls by cause and says when a cause is rising. <Ui page="/">Unusually slow calls</Ui> lists calls that took over 10 times their tool's usual time and over 30 seconds, and <Ui page="/">Retry loops</Ui> the same call tried again after failing. <Ui page="/">Calls that went wrong</Ui> leaves out real results, such as failing tests or a search that found nothing, since the tool did its job.
- **Time and context:** <Ui page="/">Time per turn</Ui> and <Ui page="/">Time per conversation</Ui> leave out the time an agent waited on you, so the gap between active and total time is your own. <Ui page="/">Tokens by tool</Ui> shows what each tool puts in the context.
- **Labelled patterns:** <Ui page="/">Didn't finish</Ui>, <Ui page="/">Conversations by goal</Ui>, <Ui page="/">Tokens per conversation</Ui> and the two reaction cards read labels a model writes. Until you [label](/labelling/), they say so and the rest of the dashboard works as usual.

## Open the evidence behind a number

A number that counts calls opens the steps behind it: a cause in <Ui page="/">Tool problems</Ui> its failed steps, a row of <Ui page="/">Unusually slow calls</Ui> that tool's slow calls, and <Ui page="/">Calls that went wrong</Ui> every failed step.

<Shot id="steps" caption="Following the most common cause from the Tool problems card: each failed step, what it ran, and how long the tool usually takes." />

A step opens its conversation at that turn, with the step open in the Turn pane. Numbers that count conversations open the conversation list with its filter filled in, so you can change it from there.

## Find a conversation

<Ui page="/conversations">Conversations</Ui> lists every conversation in the range, latest message first. Type words to search what was said and the titles, and add fields to narrow it:

| Field      | Matches                                        | Example                              |
| ---------- | ---------------------------------------------- | ------------------------------------ |
| `goal:`    | The goal a model labelled                      | `goal:"fix a bug"`                   |
| `outcome:` | The outcome a model labelled                   | `outcome:done`                       |
| `by:`      | Who started it: `me`, `agent` or `script`      | `by:me`                              |
| `harness:` | The agent tool, `claude` or `opencode`         | `harness:opencode`                   |
| `agent:`   | The agent's name                               | `agent:build`                        |
| `model:`   | Part of a model's name                         | `model:opus`                         |
| `project:` | The project's directory, or its last part      | `project:shop`                       |
| `tool:`    | A tool it called                               | `tool:Edit`                          |
| `cause:`   | The cause of a failed call                     | `cause:"Edit didn't match the file"` |
| `has:`     | `failures`, `retry`, `correction` or `spawned` | `has:retry`                          |

A value with a space takes quotes, commas give alternatives (`outcome:blocked,failed,abandoned`), and different fields must all match. To find the bug fixes in one project that hit failures: `project:billing goal:"fix a bug" has:failures`. The buttons under the filter add the common ones with one click.

<Shot id="conversations" caption="Every conversation in the range, with its goal and outcome once a model has labelled it." />

[Labels](/labelling/#what-labels-add) lists every goal and outcome a model chooses from.

## Read what happened in one conversation

<Shot id="conversation" caption="A conversation from its top: the session map, the thread and the Turn pane." />

The header separates how long the conversation took from how long the agent was active, and counts its failed steps, the agents it spawned and its compactions. <Ui page="/conversations/:id">Plugins</Ui> lists the tools each MCP server or plugin offered, which were used, and what their definitions added to the context.

The <Ui page="/conversations/:id">Session map</Ui> draws the whole conversation as one strip, with marks for failed steps, your reactions, compactions and spawned agents, so you can see where to look in a long run. Switch it between <Ui page="/conversations/:id">by time</Ui> and <Ui page="/conversations/:id">by turn</Ui>, and click or drag on it to jump. Under each prompt, the reactions a model labelled mark how you answered the agent: a <Ui page="/conversations/:id">correction</Ui>, <Ui page="/conversations/:id">pushback</Ui>, a clarification, a redirect, teaching or praise.

## Inspect a turn

The Turn pane splits the turn's time into <Ui page="/conversations/:id">Model</Ui>, <Ui page="/conversations/:id">Tools</Ui> and <Ui page="/conversations/:id">Waiting</Ui>, shows what filled its <Ui page="/conversations/:id">Context</Ui>, and lists its steps as a tree. Open a step to see its input and output, how long the tool usually takes, and how many steps like it the range holds.

<Shot id="turn-pane" caption="A turn whose test run failed three times before it passed." />

As you scroll, the map and the Turn pane follow the turn you are reading, and the address bar keeps it, so a link you copy reopens that turn.

<Video id="conversation-scroll" />

| Key       | Moves to                                         |
| --------- | ------------------------------------------------ |
| `j`, `k`  | The next or the previous turn                    |
| `J`, `K`  | The next or the previous turn with a failed step |
| `n`, `N`  | The next or the previous failed step             |
| `gg`, `G` | The first or the last turn                       |
| `[`, `]`  | Collapse or expand the spawned agents            |
| `Esc`     | Close the open step                              |

## See what your tools cost in context

<Ui page="/tokens">Tokens by tool</Ui> shows which tools and skills put the most text into your agents' context. The numbers are estimates, at about four characters a token, from the text of each call.

<Shot id="tokens" caption="Tool context, grouped by plugin, then every tool and skill, largest first." />

<Ui page="/tokens">By plugin</Ui> sums the tools by where they come from: each plugin's server, the agent's own tools under <Ui page="/tokens">Built in</Ui>, then <Ui page="/tokens">Skills</Ui>. The list below separates a tool's <Ui page="/tokens">Definition</Ui>, which its name, description and input schema add to every request that carries the tool whether or not the agent calls it, from what its calls put in the context. Definition shows the largest one conversation in the range recorded loading, or `none` when no session recorded it.
