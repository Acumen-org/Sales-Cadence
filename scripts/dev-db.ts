import fs from 'node:fs';
import path from 'node:path';

/**
 * `pnpm dev:db`: start an embedded Postgres for local development when Docker is not around.
 * Data persists in .pgdata-dev. Prints the DATABASE_URL to put in .env. Ctrl+C stops it.
 *
 *   pnpm dev:db            # port 5434
 *   pnpm dev:db 5500       # custom port
 */
async function main() {
  const port = Number.parseInt(process.argv[2] ?? '5434', 10);
  const databaseDir = path.join(process.cwd(), '.pgdata-dev');
  const fresh = !fs.existsSync(databaseDir);
  const mod = await import('embedded-postgres');
  const EmbeddedPostgres = (mod.default ?? mod) as unknown as new (opts: Record<string, unknown>) => {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  };
  const pg = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {} });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('cadence');
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
