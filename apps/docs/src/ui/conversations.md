# Conversations

<Ui page="/conversations">Conversations</Ui> lists every conversation in the range, latest message first.

<Shot id="conversations" caption="The conversations of the last 7 days." />

## The list

Each row shows the conversation's outcome, its title, its goal, how many steps it took and how many failed, how long it was active, the harness, the agent and who started it, and when it ran. A conversation no model has labelled yet says so in place of its outcome. A row opens [the conversation](/ui/conversation).

## Filter

Type in the filter and press <Ui page="/conversations">Filter</Ui>. Fields narrow by what Log Book knows of a conversation; any other word is looked for in what was said and in the titles.

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

- A value with a space takes quotes.
- Commas give alternatives: `outcome:blocked,failed,abandoned`.
- Different fields must all match: `project:billing has:failures`.
- Free text: `goal:review late fee` finds the review conversations that mention a late fee.

The goals are the ones a model chooses from, such as `build a feature`, `fix a bug`, `review` and `explore the codebase`. The outcomes are `done`, `partly done`, `handed off`, `blocked`, `failed`, `abandoned`, `no task` and `unclear`.

The buttons under the filter add or remove common filters with one click: <Ui page="/conversations">Started by me</Ui>, <Ui page="/conversations">Started by an agent</Ui>, <Ui page="/conversations">Didn't finish</Ui>, <Ui page="/conversations">Failed steps</Ui>, <Ui page="/conversations">Retry loops</Ui>, <Ui page="/conversations">Corrections</Ui> and <Ui page="/conversations">Spawned agents</Ui>.

<Shot id="conversations-filter" caption="The conversations filtered by a goal and an outcome." />

The dashboard's conversation counts open this list with their filter filled in, so you can change it from there.
