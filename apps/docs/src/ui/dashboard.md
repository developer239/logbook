# Dashboard

The dashboard is the first page Log Book opens. It answers where your agents' time went over a range of days, and each number links to the conversations or steps behind it.

<Shot id="dashboard" caption="The dashboard over 30 days of the demo's data." />

## The range

The top bar sets the range every page shows: <Ui page="/">Today</Ui>, <Ui page="/">7 days</Ui>, <Ui page="/">30 days</Ui> or <Ui page="/">All</Ui>. <Ui page="/">Custom</Ui> opens a form for a span of days of your own, from one day to another, both included. Log Book starts on 7 days.

## The strip

Four figures head the page, each compared with the range before it of the same length:

- <Ui page="/">Conversations</Ui>: how many conversations ran, and how many of them you started, agents started and scripts started.
- <Ui page="/">Active hours</Ui>: the model's and the tools' time, without the time an agent waited on you.
- <Ui page="/">Finished</Ui>: how many conversations a model labelled done, as a share of all of them.
- <Ui page="/">Calls that went wrong</Ui>: the tool calls that failed, as a share of all calls. Real results, such as failing tests or a search that found nothing, are left out: the tool did its job.

## The cards

- <Ui page="/">Tool problems</Ui>: failed calls by cause, with the tools each cause hit most and a line for the last 7 days. A cause that is rising says so. Each cause opens its failed steps.
- <Ui page="/">Time per turn</Ui>: how long a turn takes from your prompt to the final reply, by goal, without the time the agent waited on you. The dot is the typical turn; the tick marks the time 1 in 10 turns take longer than.
- <Ui page="/">Time per conversation</Ui>: for the conversations you started, the typical time the agent worked, and the typical time from the first message to the last. The gap between them is the time the agent waited on you or sat idle.
- <Ui page="/">Unusually slow calls</Ui>: calls that took over 10 times their tool's usual time, and over 30 seconds, the furthest first.
- <Ui page="/">Retry loops</Ui>: runs of the same call tried again after failing, with how many tries each took.
- <Ui page="/">Didn't finish</Ui>: the conversations a model labelled blocked, failed or abandoned, newest first, with the note the model wrote.
- <Ui page="/">Reactions to the agent</Ui>: corrections, pushback and praise, as shares of your prompts, week by week.
- <Ui page="/">Reactions from the agent</Ui>: how often each model's replies asked permission for something it could just do, gave in to you without a new reason, or pushed back on you.
- <Ui page="/">Conversations by goal</Ui>: what the conversations were for, split into yours, agents' and scripts'.
- <Ui page="/">Tokens per conversation</Ui>: the typical tokens a conversation reads and its largest single request, by goal.
- <Ui page="/">Tokens by tool</Ui>: what each tool's calls put in the context, estimated from their text. It opens the [Tokens by tool](/ui/tokens) page.

<Shot id="reactions-card" caption="Reactions to the agent: your corrections, pushback and praise, week by week." />

<Shot id="agent-reactions" caption="Reactions from the agent: how often each model asks, gives in or pushes back." />

## Cards that need labelling

Five cards read labels a model writes: <Ui page="/">Didn't finish</Ui>, <Ui page="/">Conversations by goal</Ui>, <Ui page="/">Tokens per conversation</Ui> and the two reaction cards. Until you label your sessions, they say so instead of showing numbers, and the rest of the dashboard works from rules-based labels. [Syncing and empty states](/ui/states#not-labelled-yet) shows what they say.

## On a phone

The cards stack in one column.

<Shot id="dashboard-phone" />
