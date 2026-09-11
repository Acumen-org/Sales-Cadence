import type { Prisma } from '@prisma/client';

/** Words typed into a search box: every word has to match somewhere, in any field. */
export function searchTerms(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
}

const PERSON_FIELDS = ['firstName', 'lastName', 'companyName', 'email', 'jobTitle', 'phone', 'city'] as const;
const COMPANY_FIELDS = ['name', 'domain', 'industry', 'city'] as const;

/** "dummy one" finds Dummy One; "one dummy-b" finds them by company; a few letters find everyone they start. */
export function personSearchWhere(q: string): Prisma.PersonCacheWhereInput | null {
  const terms = searchTerms(q);
  if (!terms.length) return null;
  return { AND: terms.map((term) => ({ OR: PERSON_FIELDS.map((field) => ({ [field]: { contains: term, mode: 'insensitive' as const } })) })) };
}

export function companySearchWhere(q: string): Prisma.CompanyCacheWhereInput | null {
  const terms = searchTerms(q);
  if (!terms.length) return null;
  return { AND: terms.map((term) => ({ OR: COMPANY_FIELDS.map((field) => ({ [field]: { contains: term, mode: 'insensitive' as const } })) })) };
}
