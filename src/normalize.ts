import type { Config } from './cli.js';
import type { ObjectType } from './mysql.js';

/**
 * Normalize raw DDL to remove volatile values that change without any real
 * structural difference, keeping snapshot-to-snapshot diffs meaningful.
 *
 * Normalizations applied:
 * - Table DDL: the `AUTO_INCREMENT=N` *table option* carries the live counter
 *   value. The column attribute `... AUTO_INCREMENT` (no `=`) is left untouched.
 * - View/routine/trigger/event DDL: the `DEFINER=`user`@`host`` tag records who
 *   created the object on which host — environment-specific noise. The separate
 *   `SQL SECURITY DEFINER` clause is left untouched.
 * - Table/database DDL: the `DEFAULT CHARSET=`/`COLLATE=` table options and the
 *   `CREATE DATABASE ... DEFAULT CHARACTER SET ...` clause (default-on; pass
 *   `--keep-charset` to retain). Per-column `CHARACTER SET`/`COLLATE`
 *   (space-separated, no `=`) is left untouched.
 */
export function normalizeDdl(
  type: ObjectType,
  ddl: string,
  config: Config,
): string {
  let out = ddl;

  if (type === 'table' && !config.keepAutoIncrement) {
    // Remove ` AUTO_INCREMENT=123` from the table-options tail.
    out = out.replace(/\s+AUTO_INCREMENT=\d+/g, '');
  }

  if (!config.keepDefiner) {
    // Remove the environment-specific ` DEFINER=`user`@`host`` tag emitted on
    // views, routines, triggers and events. The pattern is specific enough that
    // table/database DDL is unaffected; `SQL SECURITY DEFINER` is left intact.
    // Consuming the leading whitespace avoids leaving a double space.
    out = out.replace(/\s+DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`/g, '');
  }

  if (!config.keepCharset) {
    if (type === 'table') {
      // Table-options tail. The `=` form is unique to table options; per-column
      // charset/collation uses the space-separated form and is left untouched.
      out = out.replace(/ DEFAULT CHARSET=\w+/g, '');
      out = out.replace(/ COLLATE=\w+/g, '');
    }
    if (type === 'database') {
      // `CREATE DATABASE `x` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE ... */`.
      // The version comment holds only charset/collation, so drop the whole
      // comment to avoid leaving an empty `/*!40100 */` (COLLATE is optional).
      out = out.replace(
        /\s*\/\*!\d+ DEFAULT CHARACTER SET \w+(?: COLLATE \w+)? \*\//g,
        '',
      );
    }
  }

  // Trim trailing whitespace on each line and normalize the file ending.
  out = out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');

  return out;
}
