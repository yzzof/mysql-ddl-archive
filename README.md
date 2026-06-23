# mysql-ddl-archive

Takes a snapshot of a MySQL server's structure (DDL), maintaining a history.

Each run connects to a MySQL server, reads the canonical `SHOW CREATE ...`
statement for **every** DDL-bearing object, and writes one `.sql` file per
object into a fresh **timestamped** snapshot directory — one directory per
database, with object types in subdirectories. Because the output is the
server's own DDL, every option (engines, charsets/collations, row formats,
partitioning, foreign keys, CHECK constraints, generated columns, definers,
sql_mode, view algorithms, event schedules, …) is captured automatically.

## Object types captured

| Type | Statement | Location in snapshot |
|------|-----------|----------------------|
| Database / schema | `SHOW CREATE DATABASE` | `<db>/database.sql` |
| Base table | `SHOW CREATE TABLE` | `<db>/tables/<name>.sql` |
| View | `SHOW CREATE VIEW` | `<db>/views/<name>.sql` |
| Stored procedure | `SHOW CREATE PROCEDURE` | `<db>/procedures/<name>.sql` |
| Function | `SHOW CREATE FUNCTION` | `<db>/functions/<name>.sql` |
| Trigger | `SHOW CREATE TRIGGER` | `<db>/triggers/<name>.sql` |
| Event | `SHOW CREATE EVENT` | `<db>/events/<name>.sql` |

Indexes, foreign keys and partitioning are part of `SHOW CREATE TABLE`, so they
live inside each table file.

## Install

```sh
npm install
npm run build      # compiles TypeScript to dist/
```

## Usage

```sh
# Whole server (system schemas excluded by default)
node dist/index.js -h 127.0.0.1 -u root -p secret

# Without building, run the TypeScript directly (Node 22.6+/24):
npm start -- -h 127.0.0.1 -u root -p secret
```

### Examples

```sh
# A single database
node dist/index.js -d mydb

# A single table within a database
node dist/index.js -d mydb -t orders

# Exclude databases / specific tables
node dist/index.js --exclude-database analytics --exclude-table mydb.audit_log

# Only certain object types
node dist/index.js -d mydb --object-types tables,views

# Keep the live AUTO_INCREMENT counter in table DDL (off by default)
node dist/index.js -d mydb --keep-auto-increment

# Custom output location
node dist/index.js -o /backups/ddl

# Single up-to-date copy (no timestamp dirs): overwrite + delete removed objects
node dist/index.js --no-timestamp
```

## Output layout

Snapshots are grouped per server in a `<host>_<port>` folder, then either a
timestamped directory (default) or a stable `current/` directory
(`--no-timestamp`):

```
snapshots/
  127.0.0.1_3306/
    2026-06-23T01-05-00Z/        # default: a new dir each run
      manifest.json              # server version, options, counts, errors, pruned list
      mydb/
        database.sql
        tables/orders.sql
        views/active_users.sql
        procedures/sync_totals.sql
        functions/fullname.sql
        triggers/orders_ai.sql
        events/nightly_rollup.sql
    current/                     # --no-timestamp: overwritten + pruned in place
      manifest.json
      mydb/...
```

Stored programs (procedures, functions, triggers, events) are wrapped in
`DELIMITER $$ … $$` so each file is independently replayable.

### `--no-timestamp` (sync mode)

Instead of a new timestamped directory, the run writes to
`<output>/<host_port>/current/` and **mirrors the server's current state**:
existing files are overwritten, and files for objects that no longer exist are
deleted. On a full-server run (no `--database`/`--table`), whole database
folders are also removed when that database no longer exists on the server.
A scoped run (`--database`/`--table`, or a restricted `--object-types`) only
prunes within the databases and object types it actually processed, never
touching sibling folders. The list of removed paths is recorded in
`manifest.json` under `pruned`.

## Options

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `-h, --host` | `MYSQL_HOST` | `127.0.0.1` | Host |
| `-P, --port` | `MYSQL_PORT` | `3306` | Port |
| `-u, --user` | `MYSQL_USER` | `root` | User |
| `-p, --password` | `MYSQL_PASSWORD` | _(prompted)_ | Password; if omitted, prompted at startup without echoing |
| `-S, --socket` | `MYSQL_SOCKET` | — | Unix socket path |
| `-d, --database` | | | Only this database (repeatable) |
| `-t, --table` | | | Only this table (needs one `--database`; repeatable) |
| `--exclude-database` | | | Skip a database (repeatable) |
| `--exclude-table` | | | Skip a `db.table` (repeatable) |
| `--include-system` | | off | Include `information_schema`/`mysql`/`sys`/`performance_schema` |
| `--object-types` | | all | CSV subset of `database,tables,views,procedures,functions,triggers,events` |
| `-o, --output` | | `./snapshots` | Base output directory |
| `--no-timestamp` | | off | Write to `<host_port>/current/` and prune to match the server (see above) |
| `--keep-auto-increment` | | off | Keep `AUTO_INCREMENT=N` in table DDL |
| `-c, --config` | | `./config.json` | Path to a JSON config file |
| `--help` | | | Show help |

## Configuration file

Any option can be set in a `config.json` (default location: project directory,
or pass `-c/--config <path>`). Values resolve with this precedence:

**CLI flag > `config.json` > environment variable > built-in default.**

Keys are camelCase and mirror the options, e.g.:

```json
{
  "host": "db.internal",
  "port": 3306,
  "user": "readonly",
  "output": "./snapshots",
  "objectTypes": ["database", "tables", "views"],
  "excludeDatabases": ["analytics"],
  "noTimestamp": true
}
```

Array keys also accept the singular form (`database`/`databases`,
`table`/`tables`). Leave `password` out of a committed `config.json`; supply it
via `MYSQL_PASSWORD`, `--password`, or the hidden startup prompt. Unknown keys
are warned about and ignored.

## History

By default each run writes a brand-new timestamped directory under the per-host
folder, so previous snapshots are preserved. `AUTO_INCREMENT` counters are
stripped by default, so committing the `snapshots/` tree to git (or diffing two
timestamped dirs) shows only real structural changes between snapshots.
```
diff -ru snapshots/127.0.0.1_3306/2026-06-22T*/mydb \
         snapshots/127.0.0.1_3306/2026-06-23T*/mydb
```
Use `--no-timestamp` if you prefer a single, always-current mirror that you let
git track over time instead.
