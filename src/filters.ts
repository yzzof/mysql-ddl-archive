import { SYSTEM_SCHEMAS, type Config, type ObjectTypeOption } from './cli.js';

/**
 * Resolve the final list of databases to snapshot from the full server list,
 * applying --database / --exclude-database / --include-system rules.
 */
export function resolveDatabases(
  allDatabases: string[],
  config: Config,
): string[] {
  const { databases, excludeDatabases, includeSystem } = config;
  const excludeSet = new Set(excludeDatabases);
  const systemSet = new Set<string>(SYSTEM_SCHEMAS);

  let selected: string[];
  if (databases.length > 0) {
    // Explicit selection: keep only those that actually exist on the server.
    const present = new Set(allDatabases);
    selected = databases.filter((db) => present.has(db));
  } else {
    selected = allDatabases.filter(
      (db) => includeSystem || !systemSet.has(db),
    );
  }

  return selected.filter((db) => !excludeSet.has(db));
}

/**
 * Build a predicate that decides whether a `db`.`table` should be included,
 * honoring --table (single-db restriction) and --exclude-table.
 */
export function makeTableFilter(
  config: Config,
): (db: string, table: string) => boolean {
  const includeTables = new Set(config.tables);
  const excludeTables = new Set(config.excludeTables);
  const restrictToTables = config.tables.length > 0;

  return function keepTable(db: string, table: string): boolean {
    if (excludeTables.has(`${db}.${table}`)) return false;
    if (restrictToTables && !includeTables.has(table)) return false;
    return true;
  };
}

/** Whether a given object type is enabled for this run. */
export function makeTypeFilter(
  config: Config,
): (type: ObjectTypeOption) => boolean {
  const enabled = new Set<ObjectTypeOption>(config.objectTypes);
  return (type: ObjectTypeOption) => enabled.has(type);
}
