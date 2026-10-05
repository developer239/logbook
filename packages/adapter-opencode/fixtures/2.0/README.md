# OpenCode 2.0 fixture set

`opencode.sql` holds the tables the adapter reads, as OpenCode 2.0.21 creates them (its schema, not a user's data); `rows.sql` holds invented rows: the home is `/home/example`, and no id, path, prompt or reply comes from a real machine. The database is built from both at test time and never committed.

| Session         | What it exercises                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ses_example01` | Every message type (user, system, synthetic, assistant, compaction, agent-switched, model-switched, idle), an unknown type and unparseable `data` |
| `ses_example02` | A session migrated from 1.x whose `session_message` completion OpenCode 2 rewrote; the 1.x `message` row keeps the original                       |
| `ses_example03` | An assistant row with an error                                                                                                                    |
| `ses_example04` | A session started by `ses_example03` (`parent_id`)                                                                                                |
| `ses_example05` | A session with no messages                                                                                                                        |
| `ses_example06` | An image-only prompt                                                                                                                              |
| `ses_example07` | A root session whose first prompt is a whole quoted string with a space (`opencode run`)                                                          |
| `ses_example08` | A quoted prompt that is not the first                                                                                                             |
| `ses_example09` | A session recorded by OpenCode 2.1.4, newer than the tested 2.0                                                                                   |

Command files: `~/.config/opencode/commands/release.md` (global) and `/home/example/work/shop/.opencode/commands/review.md` (project).
