# CLI recipes

Every page of Log Book is also a `logbook` command, and every command only reads the warehouse unless it says otherwise. These are the common jobs; [CLI reference](/reference/cli) has every option.

## Find what keeps failing

```sh
logbook report failures --max-rows 20
```

Failed tool calls by tool, failed model requests, shell calls by purpose with how many failed and why, calls repeated after failing, and interruptions. One report of the topic at a time:

```sh
logbook report tool-failures
logbook report repeats
```

## Find what is slow

```sh
logbook report slow
logbook report longest-turns
logbook report turn-time
```

The slowest tool calls, the longest turns by active time, and where turn time went, split into model time, tool time and idle. `logbook report performance` prints all of them, with tool output sizes and the heaviest sessions.

## Find a conversation you remember

```sh
logbook search '"connection refused"'
logbook search 'invoice AND rounding' --limit 5
```

Search reads prompts, replies, reasoning and tool output, with SQLite's full-text syntax: quoted phrases, `AND`, `OR`, `NOT` and `prefix*`. To list sessions instead:

```sh
logbook sessions --project shop --since 2026-09-01
logbook sessions --harness opencode --limit 10
```

## Read one session

```sh
logbook timeline claude-code:de30da7a-0000-4000-8000-000000000001
logbook tree claude-code:de30da7a-0000-4000-8000-000000000001
```

The timeline prints the prompts, replies and tool calls in order, with their durations; the tree prints the subagent sessions it started. A session is its warehouse id, as above, or the id your agent shows.

## Ask your own question

```sh
logbook sql "SELECT bare_name, COUNT(*) AS calls FROM tool_call GROUP BY bare_name ORDER BY calls DESC LIMIT 10"
```

The query is read-only. [Database schema](/reference/schema) lists the tables, and `logbook sql --help` prints them, so a coding agent can write its own queries.

## Let your coding agent ask

Ask Claude Code or OpenCode something like "what kept failing in this project last week?" and it can answer from your history with these commands. What a command prints becomes part of that agent's conversation, so it reaches the agent's model provider like anything else the agent reads.

## Every report

| Topic         | Reports                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `failures`    | `tool-failures`, `errors`, `shell`, `tool-causes`, `repeats`, `interrupts`, `recovery` |
| `performance` | `tools`, `slow`, `latency`, `turn-time`, `longest-turns`, `heavy`, `output`, `context` |
| `usage`       | `skills`, `commands`, `families`, `models`, `daily`                                    |
| `sessions`    | `calls`, `chains`, `work`, `goals`, `outcomes`, `links`                                |
| `interaction` | `reactions`, `replies`                                                                 |

`logbook report <topic>` prints a topic's reports, and `logbook report` with no name prints them all. `goals`, `outcomes`, `reactions` and `replies` read [model labels](/labelling/).
