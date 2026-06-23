import mysql from 'mysql2/promise';

import type { ConnectionConfig } from './cli.js';

/** Singular object types that map to a `SHOW CREATE <KEYWORD>` statement. */
export type ObjectType =
  | 'database'
  | 'table'
  | 'view'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'event';

/** Quote a MySQL identifier, escaping embedded backticks. */
export function quoteIdent(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/** Quote a fully-qualified `db`.`name`. */
function qualified(db: string, name: string): string {
  return `${quoteIdent(db)}.${quoteIdent(name)}`;
}

// Result column holding the DDL for each `SHOW CREATE ...` statement.
const DDL_COLUMN: Record<ObjectType, string> = {
  database: 'Create Database',
  table: 'Create Table',
  view: 'Create View',
  procedure: 'Create Procedure',
  function: 'Create Function',
  trigger: 'SQL Original Statement',
  event: 'Create Event',
};

const SHOW_CREATE_KEYWORD: Record<ObjectType, string> = {
  database: 'DATABASE',
  table: 'TABLE',
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER',
  event: 'EVENT',
};

type Row = Record<string, unknown>;

export class MysqlClient {
  private readonly conn: mysql.Connection;

  private constructor(conn: mysql.Connection) {
    this.conn = conn;
  }

  static async connect(connectionConfig: ConnectionConfig): Promise<MysqlClient> {
    const conn = await mysql.createConnection({
      host: connectionConfig.host,
      port: connectionConfig.port,
      user: connectionConfig.user,
      password: connectionConfig.password,
      socketPath: connectionConfig.socketPath,
      multipleStatements: false,
      dateStrings: true,
    });
    return new MysqlClient(conn);
  }

  async serverVersion(): Promise<string> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      'SELECT VERSION() AS version',
    );
    return (rows[0]?.version as string | undefined) ?? 'unknown';
  }

  /** All schema names on the server. */
  async listDatabases(): Promise<string[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
    );
    return rows.map((r) => r.name as string);
  }

  /** { tables, views } for one schema. */
  async listTablesAndViews(
    db: string,
  ): Promise<{ tables: string[]; views: string[] }> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [db],
    );
    const tables: string[] = [];
    const views: string[] = [];
    for (const r of rows) {
      if (r.type === 'VIEW') views.push(r.name as string);
      else if (r.type === 'BASE TABLE') tables.push(r.name as string);
      // SYSTEM VIEW and other types are intentionally skipped.
    }
    return { tables, views };
  }

  /** { procedures, functions } for one schema. */
  async listRoutines(
    db: string,
  ): Promise<{ procedures: string[]; functions: string[] }> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type
         FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ?
        ORDER BY ROUTINE_NAME`,
      [db],
    );
    const procedures: string[] = [];
    const functions: string[] = [];
    for (const r of rows) {
      if (r.type === 'PROCEDURE') procedures.push(r.name as string);
      else if (r.type === 'FUNCTION') functions.push(r.name as string);
    }
    return { procedures, functions };
  }

  async listTriggers(db: string): Promise<string[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT TRIGGER_NAME AS name
         FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?
        ORDER BY TRIGGER_NAME`,
      [db],
    );
    return rows.map((r) => r.name as string);
  }

  async listEvents(db: string): Promise<string[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT EVENT_NAME AS name
         FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ?
        ORDER BY EVENT_NAME`,
      [db],
    );
    return rows.map((r) => r.name as string);
  }

  /**
   * Run the appropriate `SHOW CREATE <type>` and return the raw DDL string.
   */
  async showCreate(type: ObjectType, db: string, name: string): Promise<string> {
    const keyword = SHOW_CREATE_KEYWORD[type];
    const target = type === 'database' ? quoteIdent(db) : qualified(db, name);

    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SHOW CREATE ${keyword} ${target}`,
    );
    const row = rows[0] as Row | undefined;
    if (!row) throw new Error(`No DDL returned for ${type} ${target}`);

    const ddl = pickDdlColumn(row, DDL_COLUMN[type]);
    if (ddl == null) {
      throw new Error(
        `Empty DDL for ${type} ${target} ` +
          `(insufficient privileges to read the definition?)`,
      );
    }
    return ddl;
  }

  async end(): Promise<void> {
    await this.conn.end();
  }
}

/**
 * Look up the DDL column from a SHOW CREATE result row, tolerant of
 * case/whitespace differences across MySQL/MariaDB versions.
 */
function pickDdlColumn(row: Row, expected: string): string | undefined {
  if (expected in row) return row[expected] as string;
  const wantKey = expected.toLowerCase().replace(/\s+/g, '');
  for (const key of Object.keys(row)) {
    if (key.toLowerCase().replace(/\s+/g, '') === wantKey) {
      return row[key] as string;
    }
  }
  return undefined;
}
