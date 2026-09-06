import fs from 'node:fs';
import path from 'node:path';

// Runs in every test worker before the test file. Workers inherit process.env from
// global setup, but read the URL file as a fallback (e.g. threads pool, editors).
if (!process.env.DATABASE_URL) {
  const file = path.join(process.cwd(), '.test-db-url');
  if (fs.existsSync(file)) process.env.DATABASE_URL = fs.readFileSync(file, 'utf8').trim();
}
process.env.TWENTY_MODE = 'mock';
process.env.CADENCE_DRY_RUN = process.env.CADENCE_DRY_RUN ?? 'false';
