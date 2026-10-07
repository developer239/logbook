# Environment variables

<!--@include: ../.generated/environment.md-->

`LOGBOOK_DB` moves the warehouse file only; `XDG_DATA_HOME` moves Log Book's whole data directory, its sync logs among them, and the warehouse with it unless `LOGBOOK_DB` is set too. `XDG_DATA_HOME` also moves OpenCode's data, as OpenCode itself reads it.

`ANTHROPIC_API_KEY` is not in the table because it changes nothing Log Book does. Labelling checks only whether it is set, and when it is, warns before the first request that Claude Code may bill the run to that key instead of your plan.
