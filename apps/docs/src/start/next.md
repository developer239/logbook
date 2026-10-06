# Try the next version

npm's `next` tag holds a release before it moves to `latest`. To run the `next` version once, without installing it:

<InstallCommand variant="next" />

To switch to it, and to go back:

```sh
npm install -g @log-book/cli@next
npm install -g @log-book/cli@latest
```

## Give it a warehouse of its own

A `next` version may migrate the warehouse to a newer schema. Going back to `latest` then stops every command with exit 6 until `latest` catches up:

```text
The warehouse is at schema 2; this Log Book (<version>) reads schema 1. Update with npm install -g @log-book/cli@latest.
```

So try it on a warehouse of its own. Its first sync fills it from your agents' own data, which it only reads:

```sh
LOGBOOK_DB="$HOME/logbook-next/warehouse.db" npx @log-book/cli@next --port 7316
```

- `LOGBOOK_DB` must be an absolute path.
- Port 7316, because 7314 is Log Book's default and 7315 the demo's, so both can run beside it.
- Model labels live in the warehouse, so this copy starts without them.
