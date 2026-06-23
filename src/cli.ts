import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// All object types this tool can snapshot, in emission order.
// `database` is the per-schema `CREATE DATABASE`; the rest are objects within it.
export const OBJECT_TYPES = [
  'database',
  'tables',
  'views',
  'procedures',
  'functions',
  'triggers',
  'events',
] as const;

export type ObjectTypeOption = (typeof OBJECT_TYPES)[number];

// Schemas excluded by default (server internals, not user DDL).
export const SYSTEM_SCHEMAS = [
  'information_schema',
  'performance_schema',
  'mysql',
  'sys',
] as const;

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  /** undefined => not supplied; the CLI will prompt (hidden) at startup. */
  password: string | undefined;
  socketPath: string | undefined;
}

export interface Config {
  connection: ConnectionConfig;
  databases: string[];
  tables: string[];
  excludeDatabases: string[];
  excludeTables: string[];
  includeSystem: boolean;
  objectTypes: ObjectTypeOption[];
  output: string;
  keepAutoIncrement: boolean;
  /** false => write to current/ and prune; true => timestamped dirs. */
  useTimestamp: boolean;
  /** false => omit the <host_port> folder; database dirs sit higher up. */
  useHostFolder: boolean;
  /** When the output dir is a git repo, commit (and best-effort push) after a run. */
  autoCommit: boolean;
}

export type CliResult =
  | { help: true; helpText: string }
  | ({ help: false } & Config);

export const HELP = `mysql-ddl-archive — snapshot a MySQL server's DDL structure.

Usage:
  mysql-ddl-archive [options]

Options resolve as: CLI flag > config.json > env var > built-in default.

Connection:
  -h, --host <host>        MySQL host           (MYSQL_HOST, 127.0.0.1)
  -P, --port <port>        MySQL port           (MYSQL_PORT, 3306)
  -u, --user <user>        MySQL user           (MYSQL_USER, root)
  -p, --password <pass>    MySQL password       (MYSQL_PASSWORD; prompted if omitted)
  -S, --socket <path>      Unix socket path     (MYSQL_SOCKET)

Selection / filtering:
  -d, --database <db>      Only this database (repeatable)
  -t, --table <table>      Only this table (requires exactly one --database; repeatable)
      --exclude-database <db>      Skip this database (repeatable)
      --exclude-table <db.table>   Skip this table (repeatable, fully-qualified)
      --include-system     Include information_schema/performance_schema/mysql/sys
      --object-types <csv> Subset of: ${OBJECT_TYPES.join(',')} (default: all)

Output / behavior:
  -o, --output <dir>       Base output directory (default ./snapshots)
      --no-timestamp       Write to current/ instead of a new timestamped dir;
                           overwrite existing files and delete files for objects
                           (and, on a full-server run, databases) that no longer
                           exist, mirroring the server's current state.
      --no-host-folder     Omit the <host_port> folder level (see layout below)
      --auto-commit        If the output dir is a git repo, git add+commit the snapshot
                           and push it (best-effort; skipped if no remote)
      --keep-auto-increment  Do not strip AUTO_INCREMENT=N from table DDL
  -c, --config <path>      Path to a JSON config file (default ./config.json)
      --help               Show this help

Output layout: <output>/<host_port>/<UTC-timestamp>/<db>/<type>/<object>.sql
  --no-timestamp:    <output>/<host_port>/current/<db>/...
  --no-host-folder:  <output>/<UTC-timestamp>/<db>/...
  both:              <output>/<db>/...   (database folders directly in output)`;

const options = {
  host: { type: 'string', short: 'h' },
  port: { type: 'string', short: 'P' },
  user: { type: 'string', short: 'u' },
  password: { type: 'string', short: 'p' },
  socket: { type: 'string', short: 'S' },
  database: { type: 'string', short: 'd', multiple: true },
  table: { type: 'string', short: 't', multiple: true },
  'exclude-database': { type: 'string', multiple: true },
  'exclude-table': { type: 'string', multiple: true },
  'include-system': { type: 'boolean' },
  'object-types': { type: 'string' },
  output: { type: 'string', short: 'o' },
  'no-timestamp': { type: 'boolean' },
  'no-host-folder': { type: 'boolean' },
  'auto-commit': { type: 'boolean' },
  'keep-auto-increment': { type: 'boolean' },
  config: { type: 'string', short: 'c' },
  help: { type: 'boolean', default: false },
} as const;

/** Shape of an optional config.json. All keys optional. */
export interface FileConfig {
  host?: string;
  port?: number | string;
  user?: string;
  password?: string;
  socket?: string;
  output?: string;
  includeSystem?: boolean;
  keepAutoIncrement?: boolean;
  noTimestamp?: boolean;
  noHostFolder?: boolean;
  autoCommit?: boolean;
  objectTypes?: string[];
  database?: string[];
  databases?: string[];
  table?: string[];
  tables?: string[];
  excludeDatabases?: string[];
  excludeTables?: string[];
}

const KNOWN_FILE_KEYS = new Set<string>([
  'host', 'port', 'user', 'password', 'socket', 'output', 'includeSystem',
  'keepAutoIncrement', 'noTimestamp', 'noHostFolder', 'autoCommit', 'objectTypes',
  'database', 'databases', 'table', 'tables', 'excludeDatabases', 'excludeTables',
]);

/**
 * Load and lightly validate a JSON config file. Returns {} if the file does
 * not exist. Throws on invalid JSON. Warns about (and ignores) unknown keys.
 */
export function loadConfigFile(
  configPath: string,
  explicit: boolean,
): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (explicit) throw new Error(`Config file not found: ${configPath}`);
      return {};
    }
    throw new Error(`Could not read config file ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${configPath} must contain a JSON object.`);
  }

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_FILE_KEYS.has(key)) {
      console.warn(`  ! Ignoring unknown config.json key: ${key}`);
    }
  }
  return parsed as FileConfig;
}

function validateObjectTypes(raw: string[], source: string): ObjectTypeOption[] {
  const requested = raw.map((s) => String(s).trim()).filter(Boolean);
  const unknown = requested.filter(
    (t) => !OBJECT_TYPES.includes(t as ObjectTypeOption),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown object type(s) in ${source}: ${unknown.join(', ')}. ` +
        `Valid: ${OBJECT_TYPES.join(', ')}.`,
    );
  }
  return requested as ObjectTypeOption[];
}

/**
 * Parse process argv (+ config.json + env) into a normalized, validated config.
 * Throws Error (with a readable message) on invalid input.
 * Returns { help: true } when --help is requested.
 */
export function parseCli(argv: string[] = process.argv.slice(2)): CliResult {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args: argv, options, allowPositionals: false }));
  } catch (err) {
    throw new Error(`${(err as Error).message}\n\nRun with --help for usage.`);
  }

  if (values.help) return { help: true, helpText: HELP };

  const configPath = path.resolve(
    (values.config as string | undefined) ?? 'config.json',
  );
  const file = loadConfigFile(configPath, values.config != null);
  const env = process.env;

  // CLI value (undefined if not passed) > config.json > env > default.
  const databases =
    (values.database as string[] | undefined) ??
    file.databases ?? file.database ?? [];
  const tables =
    (values.table as string[] | undefined) ?? file.tables ?? file.table ?? [];

  if (tables.length > 0 && databases.length !== 1) {
    throw new Error(
      '--table requires exactly one --database. ' +
        `Got ${databases.length} database(s).`,
    );
  }

  let objectTypes: ObjectTypeOption[] = [...OBJECT_TYPES];
  const rawTypes = values['object-types'] as string | undefined;
  if (rawTypes != null) {
    objectTypes = validateObjectTypes(rawTypes.split(','), '--object-types');
  } else if (file.objectTypes != null) {
    objectTypes = validateObjectTypes(file.objectTypes, 'config.json objectTypes');
  }

  const rawPort =
    (values.port as string | undefined) ??
    (file.port != null ? String(file.port) : undefined) ??
    env.MYSQL_PORT;
  const port = Number(rawPort ?? 3306);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const includeSystem =
    (values['include-system'] as boolean | undefined) ??
    file.includeSystem ?? false;
  const keepAutoIncrement =
    (values['keep-auto-increment'] as boolean | undefined) ??
    file.keepAutoIncrement ?? false;
  const noTimestamp =
    (values['no-timestamp'] as boolean | undefined) ??
    file.noTimestamp ?? false;
  const noHostFolder =
    (values['no-host-folder'] as boolean | undefined) ??
    file.noHostFolder ?? false;
  const autoCommit =
    (values['auto-commit'] as boolean | undefined) ??
    file.autoCommit ?? false;

  return {
    help: false,
    connection: {
      host:
        (values.host as string | undefined) ?? file.host ?? env.MYSQL_HOST ?? '127.0.0.1',
      port,
      user:
        (values.user as string | undefined) ?? file.user ?? env.MYSQL_USER ?? 'root',
      // Left undefined when nothing supplies it, so index.ts prompts (hidden).
      password:
        (values.password as string | undefined) ?? file.password ?? env.MYSQL_PASSWORD,
      socketPath:
        (values.socket as string | undefined) ?? file.socket ?? env.MYSQL_SOCKET ?? undefined,
    },
    databases,
    tables,
    excludeDatabases:
      (values['exclude-database'] as string[] | undefined) ??
      file.excludeDatabases ?? [],
    excludeTables:
      (values['exclude-table'] as string[] | undefined) ??
      file.excludeTables ?? [],
    includeSystem,
    objectTypes,
    output: (values.output as string | undefined) ?? file.output ?? './snapshots',
    keepAutoIncrement,
    useTimestamp: !noTimestamp,
    useHostFolder: !noHostFolder,
    autoCommit,
  };
}
