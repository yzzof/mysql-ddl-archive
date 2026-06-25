# CLAUDE.md

Guidance for working in this repository.

## What this is

`mysql-ddl-export` is a TypeScript CLI that connects to a MySQL server and
archives the canonical DDL of **every** schema object type (databases, tables,
views, procedures, functions, triggers, events) by running `SHOW CREATE ...`.
Output is one `.sql` file per object, one directory per database. See
[README.md](README.md) for full usage.

## Layout

- [src/cli.ts](src/cli.ts) — `util.parseArgs` flags, `config.json` loader, option
  precedence (**CLI flag > config.json > env var > default**), validation, `--help`.
- [src/mysql.ts](src/mysql.ts) — `mysql2/promise` connection; `information_schema`
  enumeration + `showCreate(type, db, name)`.
- [src/filters.ts](src/filters.ts) — database/table include-exclude, object-type gating.
- [src/normalize.ts](src/normalize.ts) — strips volatile `AUTO_INCREMENT=N`.
- [src/snapshot.ts](src/snapshot.ts) — orchestration: path layout, file writing,
  `DELIMITER` wrapping, `manifest.json`, and `--no-timestamp` prune logic.
- [src/prompt.ts](src/prompt.ts) — hidden (non-echoing) password prompt.
- [src/git.ts](src/git.ts) — `--auto-commit` helpers: detect repo, stage/commit the
  snapshot, best-effort push. Wraps `git` via `child_process.execFile` (no shell, no dep);
  never throws — returns a result the caller logs.
- [src/index.ts](src/index.ts) — entry point + summary output; runs auto-commit post-snapshot.

## Output path logic (snapshot.ts)

`<output>[/<host_port>][/<timestamp>|/current]/<db>/<type>/<object>.sql`
- `--no-host-folder` (`useHostFolder=false`) drops the `<host_port>` segment.
- `--no-timestamp` (`useTimestamp=false`) writes to `current/` and prunes to mirror
  the server; when combined with `--no-host-folder`, db folders go directly in `<output>`.
- Pruning is scoped: object files only within processed databases/enabled types; whole
  database folders only on full-server runs (no `--database`/`--table`) for DBs gone
  from the server. Never touches `manifest.json` or sibling folders of a scoped run.
- **Prune safety invariant:** database-level prune only deletes a folder that is
  recognizably ours (contains `database.sql` or a type subdir — see `looksLikeSnapshotDb`)
  and skips dotfolders. This is critical because the output dir can be a git repo, so
  `.git` and any unrelated content must never be removed (with `--no-timestamp
  --no-host-folder` the snapshot dir *is* the output dir).

## Build & verify

```sh
npm install
npm run build        # tsc -> dist/ (bin = dist/index.js)
npm run typecheck    # tsc --noEmit
```

There is no live MySQL in dev here, so behavior is verified with a fake-client
harness that duck-types `MysqlClient` and calls `takeSnapshot`/`parseCli`
directly (covers layout, sync pruning, filters, and config precedence). When
changing path or prune logic, extend that harness rather than relying on a real
server. Keep `tsc --noEmit` clean (strict mode, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`; relative imports use `.js` extensions).

## Conventions / gotchas

- Add a new option in **four** places: `options` (parseArgs), `FileConfig` +
  `KNOWN_FILE_KEYS`, the resolution block in `parseCli`, and `Config`. Mirror the
  `noTimestamp`/`noHostFolder` boolean pattern (file key `noX`, internal `useX`).
- `config.json` holds real credentials and is **gitignored**; commit changes to
  `config.example.json` instead. Never put a password in a committed config.
- Rely on the server's own `SHOW CREATE` output for "all options" — do not
  hand-build DDL.
