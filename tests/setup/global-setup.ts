import fs from 'node:fs';
import path from 'node:path';
import { assertUtf8Database, runTool, UTF8_INITDB_FLAGS } from '../../scripts/local-runtime';
import { loadTestPostgres } from './embedded-postgres';

const URL_FILE = path.join(process.cwd(), '.test-db-url');
// TEST_PG_PORT lets two checkouts (git worktrees) run their suites side by side.
const PG_PORT = Number(process.env.TEST_PG_PORT) || 54329;

type Embedded = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
} & Parameters<typeof assertUtf8Database>[0];

let embedded: Embedded | undefined;

/**
 * Vitest global setup. Uses TEST_DATABASE_URL when provided (CI, Docker),
 * otherwise boots an embedded Postgres so tests run anywhere without Docker.
 * Migrations are applied with `prisma migrate deploy` so they are tested too.
 */
export default async function setup() {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const EmbeddedPostgres = await loadTestPostgres() as unknown as new (opts: Record<string, unknown>) => Embedded;
    const databaseDir = path.join(process.cwd(), '.pgdata-test');
    fs.rmSync(databaseDir, { recursive: true, force: true });
    embedded = new EmbeddedPostgres({
      databaseDir,
      user: 'postgres',
      password: 'postgres',
      port: PG_PORT,
      persistent: false,
      // UTF8 on every machine, so the tests catch what a name outside Latin-1 does (B013).
      initdbFlags: UTF8_INITDB_FLAGS,
      onLog: () => {},
      onError: (msg: unknown) => {
        if (String(msg).includes('FATAL')) console.error('[embedded-postgres]', msg);
      },
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('cadence_test');
    await assertUtf8Database(embedded, 'cadence_test', databaseDir);
    url = `postgresql://postgres:postgres@localhost:${PG_PORT}/cadence_test`;
  }

  process.env.DATABASE_URL = url;
  process.env.TWENTY_MODE = 'mock';
  process.env.CADENCE_ALLOW_MOCK = '1';
  fs.writeFileSync(URL_FILE, url);

  // No shell, as the launcher does it, so the folder's path may hold spaces (L001).
  const migrated = runTool(process.cwd(), 'prisma', ['migrate', 'deploy'], { ...process.env, DATABASE_URL: url });
  if (migrated.error || migrated.status !== 0) throw new Error(`prisma migrate deploy failed: ${migrated.error?.message ?? `exit ${migrated.status}`}`);

  return async () => {
    try {
      fs.rmSync(URL_FILE, { force: true });
    } catch {
      /* ignore */
    }
    if (embedded) {
      try {
        await embedded.stop();
      } catch (err) {
        // Windows can report EBUSY while postgres releases its files; the directory is
        // recreated from scratch on the next run anyway.
        console.warn('[embedded-postgres] stop:', err instanceof Error ? err.message : String(err));
      }
    }
  };
}
