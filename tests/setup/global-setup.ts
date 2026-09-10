import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadTestPostgres } from './embedded-postgres';

const URL_FILE = path.join(process.cwd(), '.test-db-url');
const PG_PORT = 54329;

type Embedded = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
};

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
      onLog: () => {},
      onError: (msg: unknown) => {
        if (String(msg).includes('FATAL')) console.error('[embedded-postgres]', msg);
      },
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('cadence_test');
    url = `postgresql://postgres:postgres@localhost:${PG_PORT}/cadence_test`;
  }

  process.env.DATABASE_URL = url;
  process.env.TWENTY_MODE = 'mock';
  process.env.CADENCE_ALLOW_MOCK = '1';
  fs.writeFileSync(URL_FILE, url);

  const prismaBin = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
  execSync(`"${prismaBin}" migrate deploy`, { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url }, shell: process.platform === 'win32' ? 'cmd.exe' : undefined });

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
