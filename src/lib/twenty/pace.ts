import { prisma } from '../db';

/**
 * N12: one pace for every CRM request, shared through the database by the web app and the worker.
 * Twenty allows 100 requests a minute per workspace; each request takes a slot in the current
 * minute first. The worker's background work stops short of the allowance so a rep's own clicks
 * (completion notes, opt-outs, page reads) still find room during a full listing.
 */
const INTERACTIVE_PER_MINUTE = 95;
const BACKGROUND_PER_MINUTE = 70;

let priority: 'interactive' | 'background' = 'interactive';
/** The worker calls this once at start: everything it sends is background work. */
export function setCrmRequestPriority(p: 'interactive' | 'background') {
  priority = p;
}

let warned = false;
export async function paceCrmRequest(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const cap = priority === 'background' ? BACKGROUND_PER_MINUTE : INTERACTIVE_PER_MINUTE;
  for (;;) {
    const now = Date.now();
    const minute = new Date(Math.floor(now / 60_000) * 60_000);
    let rows: Array<{ used: number }>;
    try {
      rows = await prisma.$queryRaw<Array<{ used: number }>>`
        INSERT INTO "CrmRequestBudget" ("minute", "used") VALUES (${minute}, 1)
        ON CONFLICT ("minute") DO UPDATE SET "used" = "CrmRequestBudget"."used" + 1 WHERE "CrmRequestBudget"."used" < ${cap}
        RETURNING "used"`;
      if (Math.random() < 0.02) await prisma.$executeRaw`DELETE FROM "CrmRequestBudget" WHERE "minute" < ${new Date(now - 3_600_000)}`;
    } catch (err) {
      // The pace is a courtesy to Twenty; a database hiccup must not stop CRM work.
      if (!warned) console.warn('[twenty] request pacing unavailable, sending unpaced:', err instanceof Error ? err.message : String(err));
      warned = true;
      return;
    }
    if (rows.length) return;
    await sleep(minute.getTime() + 60_000 - now + Math.floor(Math.random() * 1_000));
  }
}
