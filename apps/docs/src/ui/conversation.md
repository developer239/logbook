# A conversation

A conversation's page shows what happened in it, turn by turn: what you asked, what the agent answered, and every step it took in between.

<Shot id="conversation" caption="The showcase conversation of the demo, from its top." />

## The facts

Under the title, the facts sum the conversation up: how long it <Ui page="/conversations/:id">Took</Ui> from its first message to its last, how long it was <Ui page="/conversations/:id">Active</Ui>, its <Ui page="/conversations/:id">Steps</Ui> and how many failed, the <Ui page="/conversations/:id">Agents spawned</Ui>, how often its context was <Ui page="/conversations/:id">Compacted</Ui>, its <Ui page="/conversations/:id">Goal</Ui>, who it was <Ui page="/conversations/:id">Started by</Ui> and its <Ui page="/conversations/:id">Outcome</Ui> with the model's note. The harness, agent, model, project, branch and start time follow.

## Plugins

<Ui page="/conversations/:id">Plugins</Ui> opens the tools that plugins and MCP servers offered the conversation: how many tools each server offered, which were loaded, which were used and how often, and what their definitions added to the context. When a session did not record which tools it was offered, the block lists only the plugin tools it called.

## The session map

<Ui page="/conversations/:id">Session map</Ui> draws the whole conversation as one strip, a mark per turn. A mark shows when the turn had a failed step, the most pressing reaction under its prompt, a compaction and the agents it started. In <Ui page="/conversations/:id">by time</Ui>, each turn is as wide as the time it took; in <Ui page="/conversations/:id">by turn</Ui>, every turn is as wide as the next. A window on the map shows the part of the thread on screen. Click or drag on the map to move the thread there.

## The thread

The thread holds each turn: your prompt, the agent's reply, and a line with its steps, how many failed and how long it took. Under a prompt, the reactions a model labelled mark how you answered the agent: a <Ui page="/conversations/:id">correction</Ui>, <Ui page="/conversations/:id">pushback</Ui>, a clarification, a redirect, teaching or praise. A spawned agent shows its brief, and its steps open in the Turn pane.

## The Turn pane

The Turn pane beside the thread shows the turn you are reading: how its time split into <Ui page="/conversations/:id">Model</Ui>, <Ui page="/conversations/:id">Tools</Ui> and <Ui page="/conversations/:id">Waiting</Ui>, what filled its <Ui page="/conversations/:id">Context</Ui>, and its steps as a tree with the time each took. Open a step to see its input and output, how long the tool usually takes, and how many steps like it the range holds.

<Shot id="turn-pane" caption="The Turn pane of a turn whose test run failed three times before it passed." />

## Reading as you scroll

The page follows the turn under the reading line, 30% down the screen below the session map. As you scroll, the map moves its window and marks the active turn, the Turn pane switches to that turn, and the address bar holds it, so a link you copy opens the same turn.

<Video id="conversation-scroll" />

The keyboard moves through the thread too:

| Key       | Moves to                                         |
| --------- | ------------------------------------------------ |
| `j`, `k`  | The next or the previous turn                    |
| `J`, `K`  | The next or the previous turn with a failed step |
| `n`, `N`  | The next or the previous failed step             |
| `gg`, `G` | The first or the last turn                       |
| `[`, `]`  | Collapse or expand the spawned agents            |
| `Esc`     | Close the open step                              |
