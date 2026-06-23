import type { Config } from './cli.js';
import type { ObjectType } from './mysql.js';

/**
 * Normalize raw DDL to remove volatile values that change without any real
 * structural difference, keeping snapshot-to-snapshot diffs meaningful.
 *
 * Currently only applies to table DDL: the `AUTO_INCREMENT=N` *table option*
 * carries the live counter value. The column attribute `... AUTO_INCREMENT`
 * (no `=`) is left untouched.
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

  // Trim trailing whitespace on each line and normalize the file ending.
  out = out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');

  return out;
}
