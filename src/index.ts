#!/usr/bin/env node
import path from 'node:path';

import type { Config } from './cli.js';
import { parseCli } from './cli.js';
import { autoCommitSnapshot, isGitRepo } from './git.js';
import { MysqlClient } from './mysql.js';
import { promptHidden } from './prompt.js';
import { takeSnapshot, type Manifest } from './snapshot.js';

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

    if (config.autoCommit) {
      await runAutoCommit(config, manifest);
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

/** Commit (and best-effort push) the snapshot when output is in a git repo. */
async function runAutoCommit(config: Config, manifest: Manifest): Promise<void> {
  const outputAbs = path.resolve(config.output);
  const root = await isGitRepo(outputAbs);
  if (!root) {
    console.log(`  auto-commit: ${outputAbs} is not a git repo — skipped`);
    return;
  }

  const c = manifest.counts;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const message =
    `mysql-ddl-export: ${manifest.host} (${manifest.mode}) — ` +
    `databases=${c.database} tables=${c.table} views=${c.view} ` +
    `procedures=${c.procedure} functions=${c.function} ` +
    `triggers=${c.trigger} events=${c.event} (total ${total})\n\n` +
    `committed: ${new Date().toISOString()}`;

  const result = await autoCommitSnapshot({ root, addPath: outputAbs, message });
  if (result.committed) {
    const sha = result.sha ? ` (${result.sha})` : '';
    console.log(`  auto-commit: committed${sha}` + (result.pushed ? ' and pushed' : ''));
  }
  if (result.note) console.log(`  auto-commit: ${result.note}`);
  if (result.warning) console.warn(`  ! auto-commit: ${result.warning}`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
