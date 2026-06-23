#!/usr/bin/env node
import { parseCli } from './cli.js';
import { MysqlClient } from './mysql.js';
import { promptHidden } from './prompt.js';
import { takeSnapshot } from './snapshot.js';

async function main(): Promise<number> {
  let config;
  try {
    config = parseCli();
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  if (config.help) {
    console.log(config.helpText);
    return 0;
  }

  // Prompt (hidden) for the password if it wasn't supplied via flag or env.
  if (config.connection.password === undefined) {
    config.connection.password = await promptHidden(
      `Password for ${config.connection.user}@${config.connection.host}: `,
    );
  }

  let client: MysqlClient;
  try {
    client = await MysqlClient.connect(config.connection);
  } catch (err) {
    console.error(`Failed to connect to MySQL: ${(err as Error).message}`);
    return 1;
  }

  try {
    const manifest = await takeSnapshot(client, config);

    const { counts } = manifest;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log('');
    console.log(`Snapshot written to ${manifest.snapshotDir} (${manifest.mode} mode)`);
    console.log(
      `  databases=${counts.database} tables=${counts.table} views=${counts.view} ` +
        `procedures=${counts.procedure} functions=${counts.function} ` +
        `triggers=${counts.trigger} events=${counts.event} (total ${total})`,
    );
    if (manifest.pruned.length > 0) {
      console.log(`  pruned ${manifest.pruned.length} stale file(s)/folder(s)`);
    }
    if (manifest.errorCount > 0) {
      console.error(`  ${manifest.errorCount} object(s) failed — see manifest.json`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`Snapshot failed: ${(err as Error).message}`);
    return 1;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
