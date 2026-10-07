<!-- data-flow-case: local -->

The page and the warehouse run on your computer, and syncing never uses the network. There is no account, no server of its own, no telemetry and no update check, and the page loads nothing from the internet.

<!-- data-flow-case: labelling -->

The one exception is model labelling, and only when you start it: it runs your own Claude Code on the model you choose, and sends unredacted excerpts of your sessions to Anthropic, or to the provider your Claude Code uses, under your own login. [Privacy and security](/privacy/)
