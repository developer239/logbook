# Manage Log Book

## Update

```sh
npm install -g @log-book/cli@latest
```

On its next start, Log Book migrates the warehouse forward and says so in the warehouse line:

```text
Warehouse    ~/.local/share/log-book/warehouse.db, migrated from schema 1 to 2
```

If you update while `logbook` runs, its next sync stops and asks you to restart it:

```text
Log Book was updated while running. Press Ctrl+C and start logbook again.
```

## Remove part of your history

`logbook forget` removes the sessions you name, or every session of a project directory, for good, with their labels:

```sh
logbook forget --project ~/work/shop
```

It compacts the file as its last step, so their text leaves the file too. If you stop it after the deletion, it says so and tells you to run `logbook compact` to clear their text from the file's free space.

## Reclaim disk space

The warehouse grows as Log Book imports history; `logbook doctor` prints its size. SQLite reuses the space a re-imported session frees inside the file, so you need `logbook compact` only to give that space back to the disk:

```sh
logbook compact
```

`compact` and `forget` rewrite the whole file and need free disk of up to twice its size, which they print before they start. Ctrl+C stops a compaction and leaves the file exactly as it was. While either runs, the page keeps working, and syncs and labelling wait until it ends.

## Uninstall

```sh
npm uninstall -g @log-book/cli
```

Log Book's data directory stays: `~/.local/share/log-book`, or `log-book` inside `XDG_DATA_HOME` when you set it. To delete everything Log Book imported, stop `logbook` and remove that directory:

```sh
rm -rf ~/.local/share/log-book
```

That deletes every imported session and every label, including the history of sessions your agents have since deleted. Your agents' own files stay as they are.

## Try a preview release

Preview releases are published under npm's `next` tag before they move to `latest`. To run one once:

<InstallCommand variant="next" />

A preview may migrate the warehouse to a newer schema, and going back to `latest` would then stop every command until `latest` catches up:

```text
The warehouse is at schema 2; this Log Book (<version>) reads schema 1. Update with npm install -g @log-book/cli@latest.
```

So give it a warehouse of its own. Its first sync fills it from your agents' data, which it only reads:

```sh
LOGBOOK_DB="$HOME/logbook-next/warehouse.db" npx @log-book/cli@next --port 7316
```

`LOGBOOK_DB` must be an absolute path. Port 7316 keeps it clear of a running Log Book on the default 7314, and model labels live in the warehouse, so this copy starts without them. To switch for good, and back:

```sh
npm install -g @log-book/cli@next
npm install -g @log-book/cli@latest
```
