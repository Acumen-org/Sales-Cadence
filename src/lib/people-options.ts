import { prisma } from './db';
import { memo } from './memo';
import { tagFilter } from './crm-tags';

/**
 * The Twenty tags a person can be filtered by: every distinct tag on a live person, minus the
 * ones that are really a tier, a list category, a type or a product (those have their own
 * filters). One `unnest` over the array column instead of a distinct scan of whole rows, and kept
 * for a minute - a tag set changes when Twenty adds a tag, not between two clicks.
 */
export function personTagOptions(): Promise<string[]> {
  return memo('people:tag-options', 60_000, async () => {
    const rows = await prisma.$queryRaw<Array<{ tag: string }>>`SELECT DISTINCT unnest("tags") AS tag FROM "PersonCache" WHERE "deletedAt" IS NULL`;
    return rows.map((r) => r.tag).filter((value) => value && tagFilter(value).key === 'tag').sort();
  });
}
