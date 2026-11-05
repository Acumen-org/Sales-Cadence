import { assertUtf8Database, prepareDatabaseDirectory, UTF8_INITDB_FLAGS } from './local-runtime';

/**
 * `pnpm dev:db`: start an embedded Postgres for local development when Docker is not around.
 * Data persists in .pgdata-dev. Prints the DATABASE_URL to put in .env. Ctrl+C stops it.
 *
 *   pnpm dev:db            # port 5434
 *   pnpm dev:db 5500       # custom port
 */
async function main() {
  const port = Number.parseInt(process.argv[2] ?? '5434', 10);
  const { databaseDir, fresh } = prepareDatabaseDirectory(process.cwd(), '.pgdata-dev');
  const mod = await import('embedded-postgres');
  const EmbeddedPostgres = (mod.default ?? mod) as unknown as new (opts: Record<string, unknown>) => Parameters<typeof assertUtf8Database>[0] & {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  };
  // UTF8 whatever the machine's locale (B013); a cluster made before that is refused below.
  const pg = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port, persistent: true, initdbFlags: UTF8_INITDB_FLAGS, onLog: () => {} });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('cadence');
  try {
    await assertUtf8Database(pg, 'cadence', databaseDir);
  } catch (err) {
    await pg.stop().catch(() => undefined);
    throw err;
  }
  const url = `postgresql://postgres:postgres@localhost:${port}/cadence`;
  console.log(`READY pid=${process.pid}`);
  console.log(`DATABASE_URL=${url}`);
  console.log('Press Ctrl+C to stop.');
  const stop = async () => {
    try {
      await pg.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
