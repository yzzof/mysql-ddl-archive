import type { Config } from './cli.js';
import type { ObjectType } from './mysql.js';

/**
 * Normalize raw DDL to remove volatile values that change without any real
 * structural difference, keeping snapshot-to-snapshot diffs meaningful.
 *
 * Two normalizations are applied:
 * - Table DDL: the `AUTO_INCREMENT=N` *table option* carries the live counter
 *   value. The column attribute `... AUTO_INCREMENT` (no `=`) is left untouched.
 * - View/routine/trigger/event DDL: the `DEFINER=`user`@`host`` tag records who
 *   created the object on which host — environment-specific noise. The separate
 *   `SQL SECURITY DEFINER` clause is left untouched.
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

  // Trim trailing whitespace on each line and normalize the file ending.
  out = out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');

  return out;
}
