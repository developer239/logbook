### Examples

```sh
logbook
```

Start the host on the default port, sync, and open the page in the browser.

```sh
logbook start --no-open --port 7400
```

Serve on port 7400 without opening a browser, as over SSH.

```sh
logbook start --no-sync
```

Serve the warehouse as it is, with no first sync and no schedule.
