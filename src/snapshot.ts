import { mkdir, readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config, ObjectTypeOption } from './cli.js';
import { makeTableFilter, makeTypeFilter, resolveDatabases } from './filters.js';
import type { MysqlClient, ObjectType } from './mysql.js';
import { normalizeDdl } from './normalize.js';

// Object types whose bodies may contain ';' and therefore need DELIMITER
// wrapping to remain individually replayable.
const STORED_PROGRAMS = new Set<ObjectType>([
  'procedure',
  'function',
  'trigger',
  'event',
]);

type CollectionKey = Exclude<ObjectTypeOption, 'database'>;

// Maps the plural --object-types value to (singular type, subdirectory).
const COLLECTIONS: Record<CollectionKey, { type: ObjectType; dir: string }> = {
  tables: { type: 'table', dir: 'tables' },
  views: { type: 'view', dir: 'views' },
  procedures: { type: 'procedure', dir: 'procedures' },
  functions: { type: 'function', dir: 'functions' },
  triggers: { type: 'trigger', dir: 'triggers' },
  events: { type: 'event', dir: 'events' },
};

export type Counts = Record<ObjectType, number>;

export interface SnapshotError {
  db: string;
  name?: string;
  type?: ObjectType;
  message: string;
}

export interface Manifest {
  generatedAt: string;
  serverVersion: string;
  host: string;
  mode: 'timestamp' | 'current';
  snapshotDir: string;
  options: {
    databases: string[];
    tables: string[];
    excludeDatabases: string[];
    excludeTables: string[];
    includeSystem: boolean;
    objectTypes: ObjectTypeOption[];
    keepAutoIncrement: boolean;
  };
  databasesSnapshot: string[];
  counts: Counts;
  errorCount: number;
  errors: SnapshotError[];
  /** Files/folders removed during --no-timestamp sync pruning. */
  pruned: string[];
}

/** Filesystem-safe timestamp like 2026-06-23T01-05-00Z. */
export function snapshotStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Make an object name safe to use as a filename. Real MySQL identifiers are
 * almost always safe; anything risky is percent-encoded so the mapping is
 * reversible and never collides with a directory separator.
 */
export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    return '%' + code.toString(16).toUpperCase().padStart(2, '0');
  });
}

interface RenderArgs {
  type: ObjectType;
  db: string;
  name: string;
  ddl: string;
  serverVersion: string;
  generatedAt: string;
}

/** Render the final .sql file contents for one object. */
export function renderFile(args: RenderArgs): string {
  const { type, db, name, ddl, serverVersion, generatedAt } = args;
  const label = type === 'database' ? db : `${db}.${name}`;
  const header =
    `-- ${type.toUpperCase()}: ${label}\n` +
    `-- server: MySQL ${serverVersion}\n` +
    `-- generated: ${generatedAt}\n` +
    `-- source: mysql-ddl-archive\n\n`;

  const body = STORED_PROGRAMS.has(type)
    ? `DELIMITER $$\n${ddl}$$\nDELIMITER ;\n`
    : `${ddl};\n`;

  return header + body;
}

function emptyCounts(): Counts {
  return {
    database: 0,
    table: 0,
    view: 0,
    procedure: 0,
    function: 0,
    trigger: 0,
    event: 0,
  };
}

/**
 * Take a full DDL snapshot of the server.
 * Returns the manifest, which is also written to <snapshotDir>/manifest.json.
 */
export async function takeSnapshot(
  client: MysqlClient,
  config: Config,
): Promise<Manifest> {
  const generatedAt = new Date().toISOString();
  const serverVersion = await client.serverVersion();

  // Layout: <output>[/<host_port>][/<timestamp>|/current]
  // - host folder omitted when !useHostFolder
  // - in no-timestamp mode the "current" segment is dropped when there is also
  //   no host folder, so database dirs sit directly in <output>.
  const hostLabel = safeFileName(
    `${config.connection.host}_${config.connection.port}`,
  );
  const baseDir = config.useHostFolder
    ? path.resolve(config.output, hostLabel)
    : path.resolve(config.output);
  const snapshotDir = config.useTimestamp
    ? path.join(baseDir, snapshotStamp())
    : config.useHostFolder
      ? path.join(baseDir, 'current')
      : baseDir;

  const typeEnabled = makeTypeFilter(config);

  const allDatabases = await client.listDatabases();
  const databases = resolveDatabases(allDatabases, config);

  const counts = emptyCounts();
  const errors: SnapshotError[] = [];
  // Absolute paths of every .sql file (re)written this run; used by pruning.
  const written = new Set<string>();

  // Warn about explicitly-requested databases that don't exist.
  for (const requested of config.databases) {
    if (!allDatabases.includes(requested)) {
      const message = `Requested database not found: ${requested}`;
      console.warn(`  ! ${message}`);
      errors.push({ db: requested, message });
    }
  }

  await mkdir(snapshotDir, { recursive: true });

  for (const db of databases) {
    console.log(`* ${db}`);
    const dbDir = path.join(snapshotDir, safeFileName(db));
    await mkdir(dbDir, { recursive: true });

    // CREATE DATABASE
    if (typeEnabled('database')) {
      await writeObject({
        client, config, db, name: db, type: 'database',
        outPath: path.join(dbDir, 'database.sql'),
        serverVersion, generatedAt, counts, errors, written,
      });
    }

    // Enumerate only the collections that are enabled.
    const enumerated = await enumerate(client, db, config);

    for (const key of Object.keys(enumerated) as CollectionKey[]) {
      const items = enumerated[key];
      if (items.length === 0) continue;
      const { type, dir } = COLLECTIONS[key];
      const targetDir = path.join(dbDir, dir);
      await mkdir(targetDir, { recursive: true });
      for (const name of items) {
        await writeObject({
          client, config, db, name, type,
          outPath: path.join(targetDir, `${safeFileName(name)}.sql`),
          serverVersion, generatedAt, counts, errors, written,
        });
      }
    }
  }

  // In --no-timestamp mode, bring the existing tree up to date with the server
  // by deleting files (and dropped-database folders) we did not just write.
  let pruned: string[] = [];
  if (!config.useTimestamp) {
    pruned = await pruneToCurrent({
      snapshotDir, databases, allDatabases, config, written, typeEnabled,
    });
    for (const p of pruned) console.log(`  - pruned ${path.relative(snapshotDir, p)}`);
  }

  const manifest: Manifest = {
    generatedAt,
    serverVersion,
    host: hostLabel,
    mode: config.useTimestamp ? 'timestamp' : 'current',
    snapshotDir,
    options: {
      databases: config.databases,
      tables: config.tables,
      excludeDatabases: config.excludeDatabases,
      excludeTables: config.excludeTables,
      includeSystem: config.includeSystem,
      objectTypes: config.objectTypes,
      keepAutoIncrement: config.keepAutoIncrement,
    },
    databasesSnapshot: databases,
    counts,
    errorCount: errors.length,
    errors,
    pruned,
  };

  await writeFile(
    path.join(snapshotDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  return manifest;
}

type Enumerated = Record<CollectionKey, string[]>;

/** Enumerate enabled object collections for a database. */
async function enumerate(
  client: MysqlClient,
  db: string,
  config: Config,
): Promise<Enumerated> {
  const typeEnabled = makeTypeFilter(config);
  const keepTable = makeTableFilter(config);
  const result: Enumerated = {
    tables: [],
    views: [],
    procedures: [],
    functions: [],
    triggers: [],
    events: [],
  };

  if (typeEnabled('tables') || typeEnabled('views')) {
    const { tables, views } = await client.listTablesAndViews(db);
    if (typeEnabled('tables')) result.tables = tables.filter((t) => keepTable(db, t));
    if (typeEnabled('views')) result.views = views.filter((v) => keepTable(db, v));
  }

  if (typeEnabled('procedures') || typeEnabled('functions')) {
    const { procedures, functions } = await client.listRoutines(db);
    if (typeEnabled('procedures')) result.procedures = procedures;
    if (typeEnabled('functions')) result.functions = functions;
  }

  if (typeEnabled('triggers')) result.triggers = await client.listTriggers(db);
  if (typeEnabled('events')) result.events = await client.listEvents(db);

  return result;
}

interface WriteObjectArgs {
  client: MysqlClient;
  config: Config;
  db: string;
  name: string;
  type: ObjectType;
  outPath: string;
  serverVersion: string;
  generatedAt: string;
  counts: Counts;
  errors: SnapshotError[];
  written: Set<string>;
}

/** Fetch, normalize, render and write a single object; record errors. */
async function writeObject(args: WriteObjectArgs): Promise<void> {
  const {
    client, config, db, name, type, outPath, serverVersion, generatedAt,
    counts, errors, written,
  } = args;
  try {
    const raw = await client.showCreate(type, db, name);
    const ddl = normalizeDdl(type, raw, config);
    const contents = renderFile({ type, db, name, ddl, serverVersion, generatedAt });
    await writeFile(outPath, contents);
    written.add(outPath);
    counts[type] += 1;
  } catch (err) {
    const label = type === 'database' ? db : `${db}.${name}`;
    const message = `Failed to snapshot ${type} ${label}: ${(err as Error).message}`;
    console.warn(`  ! ${message}`);
    errors.push({ db, name, type, message });
  }
}

interface PruneArgs {
  snapshotDir: string;
  databases: string[];
  allDatabases: string[];
  config: Config;
  written: Set<string>;
  typeEnabled: (type: ObjectTypeOption) => boolean;
}

/**
 * Delete files (and dropped-database folders) that were not written this run,
 * so the target tree mirrors the server's current state. Scoped strictly:
 *  - Object files: only within databases processed this run and only within
 *    object-type subdirs that were enabled.
 *  - Whole database folders: only on a full-server run (no --database/--table),
 *    and only for databases that no longer exist on the server.
 * Returns the list of removed paths.
 */
async function pruneToCurrent(args: PruneArgs): Promise<string[]> {
  const { snapshotDir, databases, allDatabases, config, written, typeEnabled } = args;
  const pruned: string[] = [];
  const enabledCollections = (Object.keys(COLLECTIONS) as CollectionKey[]).filter(
    typeEnabled,
  );

  // Object-level prune within each processed database.
  for (const db of databases) {
    const dbDir = path.join(snapshotDir, safeFileName(db));
    for (const key of enabledCollections) {
      const sub = path.join(dbDir, COLLECTIONS[key].dir);
      const entries = await safeReaddir(sub);
      let remaining = 0;
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.sql')) {
          remaining += 1;
          continue;
        }
        const full = path.join(sub, ent.name);
        if (written.has(full)) {
          remaining += 1;
        } else {
          await unlink(full);
          pruned.push(full);
        }
      }
      if (entries.length > 0 && remaining === 0) {
        await rmdir(sub).catch(() => {});
      }
    }
  }

  // Database-level prune: only on a full-server run, only for databases gone
  // from the server (excluded/system folders still exist on the server, so
  // they survive this check).
  const fullScope = config.databases.length === 0 && config.tables.length === 0;
  if (fullScope) {
    const serverSet = new Set(allDatabases);
    for (const ent of await safeReaddir(snapshotDir)) {
      if (!ent.isDirectory()) continue;
      if (serverSet.has(decodeFolder(ent.name))) continue;
      const full = path.join(snapshotDir, ent.name);
      await rm(full, { recursive: true, force: true });
      pruned.push(full);
    }
  }

  return pruned;
}

/** readdir that returns [] when the directory doesn't exist. */
async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Reverse safeFileName's percent-encoding for comparing against db names. */
function decodeFolder(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
