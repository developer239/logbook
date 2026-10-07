# Database schema

The warehouse is one SQLite file, and `logbook sql` runs read-only queries over it. These are its tables, as `logbook sql --help` prints them.

```sh
logbook sql "SELECT bare_name, COUNT(*) AS calls FROM tool_call GROUP BY bare_name ORDER BY calls DESC LIMIT 10"
```

<!--@include: ../.generated/schema.md-->
