import fs from 'node:fs';
import path from 'node:path';

// Runs in every test worker before the test file. Workers inherit process.env from
// global setup, but read the URL file as a fallback (e.g. threads pool, editors).
if (!process.env.DATABASE_URL) {
  const file = path.join(process.cwd(), '.test-db-url');
  if (fs.existsSync(file)) process.env.DATABASE_URL = fs.readFileSync(file, 'utf8').trim();
}
process.env.TWENTY_MODE = 'mock';
process.env.MOCK_DATASET = 'test'; // the larger fixture set the tests were written against
process.env.TWENTY_API_URL = process.env.TWENTY_API_URL ?? 'http://twenty.local:3000';
process.env.CADENCE_DRY_RUN = process.env.CADENCE_DRY_RUN ?? 'false';
// Emit query events (nothing is printed) so the query-budget test can count statements.
process.env.PRISMA_LOG = process.env.PRISMA_LOG ?? 'events';
