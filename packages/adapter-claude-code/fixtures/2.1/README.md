# Claude Code 2.1 fixture set

Every value here is invented: the home is `/home/example`, and no line, id, path, prompt, reply or tool output comes from a real machine.

| Transcript                        | What it exercises                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-home-example-work-shop/…001`    | One response's lines interleaved with its tool result, a caveat (`isMeta`) line, an image-only prompt, an AI title and a custom title                                                                                                  |
| `-home-example-work-shop/…002`    | The `<command-message>`, `<local-command-` and `[Request interrupted` prefixes, a `system` / `local_command` line, a non-human `origin.kind` line and a compact summary                                                                |
| `-home-example-work-billing/…003` | A `claude -p` (`sdk-cli`) session with an API error reply and a synthetic "No response requested." reply                                                                                                                               |
| `-home-example-work-billing/…004` | A line without a timestamp and a cut last line still being written                                                                                                                                                                     |
| `-home-example-work-billing/…005` | An empty transcript                                                                                                                                                                                                                    |
| `-home-example-work-shop/…006`    | A session recorded by Claude Code 2.2.3, newer than the tested 2.1                                                                                                                                                                     |
| `-home-example-work-shop/…007`    | A call of every family row (with `TaskCreate` and `TaskUpdate`), an MCP tool of server `tracker`, an unlisted tool, a lowercase `bash`, a pending `Bash` call with input `{}`, a result without its call and a persisted-output result |

Command files: `~/.claude/commands/review.md` (global) and `/home/example/work/shop/.claude/commands/deploy.md` (project).
