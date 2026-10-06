### Examples

```sh
logbook sessions --project shop --limit 10
```

The ten newest sessions of projects matching shop.

```sh
logbook sessions --harness opencode --origin subagent
```

Only the child sessions OpenCode started.

```sh
logbook sessions --goal "fix a bug" --since 2026-09-01
```

Sessions that set out to fix a bug since September 1.
