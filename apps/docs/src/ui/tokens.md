# Tokens by tool

<Ui page="/tokens">Tokens by tool</Ui> shows what each tool and skill puts in your agents' context. The numbers are estimates, from the text of each call at about 4 characters a token.

<Shot id="tokens" caption="Tokens by tool over the last 7 days." />

## By plugin

<Ui page="/tokens">By plugin</Ui> sums the tools by where they come from: each plugin's server first, then the agent's own tools under <Ui page="/tokens">Built in</Ui>, then <Ui page="/tokens">Skills</Ui>. A group opens to its tools.

## Each tool and skill

The second list holds every tool and skill, most tokens first: how many calls it had, its <Ui page="/tokens">Definition</Ui>, what one call puts in the context, and what all its calls did.

The definition is what a tool's name, description and input schema add to every request that carries the tool, whether or not the agent calls it. It shows the largest a conversation in the range recorded loading. A tool shows `none` when no session recorded its definition.
