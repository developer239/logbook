# Update, disk space and uninstall

## Update

```sh
npm install -g @log-book/cli@latest
```

On its next start, Log Book migrates the warehouse forward and says so in the warehouse line:

```text
Warehouse    ~/.local/share/log-book/warehouse.db, migrated from schema 1 to 2
```

When you update while `logbook` runs, its next sync stops with exit 9 and prints:

```text
Log Book was updated while running. Press Ctrl+C and start logbook again.
```

## Disk space

The warehouse grows with your history, and `logbook doctor` prints its size. A sync that replaces a session's records leaves the space they took free inside the file, where the next records reuse it. Two commands give space back to the disk:

- `logbook compact` rewrites the warehouse without its free space.
- `logbook forget` removes the sessions you name, or every session of a project directory, for good, with their labels, and compacts as its last step, so their text leaves the file too.

```sh
logbook compact
logbook forget --project ~/work/shop
```

Both rewrite the whole file and need free disk of up to twice the warehouse's size, which they print before they start:

```text
Compacting ~/.local/share/log-book/warehouse.db (261 MB). This rewrites the whole file and needs up to 522 MB of free disk; syncs and labelling wait until it ends.
```

Ctrl+C stops a compaction and leaves the file as it was:

```text
Compacting stopped. SQLite rolled the rewrite back, so the warehouse file is unchanged: 261 MB, the same rows.
```

A `logbook forget` stopped after its deletion has forgotten those sessions, and says how to remove their text from the file's free space:

```text
Forgot 12 sessions and 48 labels, but compacting stopped, so their text may still be in the file's free space. Run logbook compact to remove it.
```

[The `logbook` command](/reference/cli) lists every option of both.

## Uninstall

```sh
npm uninstall -g @log-book/cli
```

Log Book's data directory stays. It is `~/.local/share/log-book`, or `log-book` inside `XDG_DATA_HOME` when you set it, and `logbook doctor` prints where the warehouse is. To delete everything Log Book imported, stop `logbook` and remove that directory:

```sh
rm -rf ~/.local/share/log-book
```

That deletes every imported session and every label, including the history of sessions your agents have since deleted. Your agents' own files stay as they are.
