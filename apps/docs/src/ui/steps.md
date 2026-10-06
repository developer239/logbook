# Steps

A dashboard number that counts calls opens the steps behind it. A cause in <Ui page="/">Tool problems</Ui> opens its failed steps, a row of <Ui page="/">Unusually slow calls</Ui> the slow calls of that tool, <Ui page="/">Retry loops</Ui> the steps in retry loops, and <Ui page="/">Calls that went wrong</Ui> every failed step.

<Shot id="steps" caption="The failed steps of the most common cause, followed from the Tool problems card." />

The heading says what the list holds, such as `Failed: Blocked by permission` or `Steps in retry loops`, with the range under it. Each step shows its tool and what it ran, its cause or what it was for, how long it took and how long the tool usually takes, and the conversation it belongs to, <Ui page="/steps">newest first</Ui>. A step opens its conversation at that turn, with the step open in the Turn pane.
