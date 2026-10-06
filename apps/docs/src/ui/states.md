# Syncing and empty states

## The sync control

The top bar shows when Log Book last synced, and syncs again when you click it. Log Book also syncs on its own every few minutes while it runs.

<Shot id="sync-control" caption="The top bar with the sync control and the Label control." />

The control reads:

- `Synced 5 min ago` after a sync that imported everything.
- `Synced 5 min ago, with problems` after a sync that imported what it could. Point at it to read the problem.
- `Sync failed 5 min ago` after a sync that failed or was stopped.
- `Syncing… (since 2 min)` while a sync runs, and you cannot start another.
- `Never synced` before the first sync.

<Ui page="/">Label</Ui>, beside it, starts labelling your sessions with a model and shows how far a run got.

## The first sync

On the first run, the page says that Log Book is reading your agents' history for the first time and how long ago the sync started, and reloads itself until the sync ends. On the demo's data this takes under a second, so there is no picture of it here.

## Nothing found

When a sync finds no agent data, the page says `No agent data found yet.` and lists each agent with where Log Book looked, and the variable that points it elsewhere, such as `CLAUDE_CONFIG_DIR` for Claude Code and `OPENCODE_DB` for OpenCode. Run the agent once on this machine, or set the variable, and sync again.

## A sync that met a problem

A sync that imported what it could and met a problem still shows your data, and the sync control says `with problems`. When nothing could be imported, the page shows the problem and asks you to run `logbook sync` in a terminal to see the full output:

```sh
logbook sync
```

When the last sync failed, the page shows `The last sync failed:` with the error, or `The last sync did not finish.`

## Not labelled yet

Until you label your sessions with a model, the cards that need labels say:

> <Ui page="/">These need labels from a model.</Ui> Open Label to see what a run would send and start it, or run `logbook labels update` in a terminal. Rules-based labels are already shown.

<Shot id="not-labelled" caption="The dashboard before any model labels: the cards that need them say so." />

[What it sends](/labelling/what-it-sends) says what a labelling run sends, and where.

## A newer warehouse

When a newer Log Book has migrated the warehouse, this one cannot read it. The page says which schema the warehouse is at and which this Log Book reads, and asks you to stop it and start the newer one. [Try the next version](/start/next#give-it-a-warehouse-of-its-own) shows how to keep a version of its own warehouse.

## While compact or forget runs

`logbook compact` and `logbook forget` rewrite the warehouse. While one runs, pages keep working, and syncs and labelling wait until it ends. The sync control reads `Compacting (since 2 min)` or `Forgetting sessions (since 2 min)`, and the Label control reads `Labelling waits: logbook compact is rewriting the warehouse (since 2 min).` or `Labelling waits: logbook forget is removing sessions (since 2 min).`
