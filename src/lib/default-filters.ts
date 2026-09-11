import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { defaultFilters } from './auth/rbac';

export type SectionDefaults = { podId: string | null; podOwnerValue: string | null; foUserId: string | null };

/** What a section opens on before any filter is touched: see `defaultFilters` for the rule. */
export async function sectionDefaults(user: SessionUser): Promise<SectionDefaults> {
  const d = defaultFilters(user);
  const podId = d.pod ? user.podIds[0] ?? null : null;
  const pod = podId ? await prisma.pod.findUnique({ where: { id: podId }, select: { podOwnerValue: true } }) : null;
  return { podId, podOwnerValue: pod?.podOwnerValue ?? null, foUserId: d.self ? user.id : null };
}

/**
 * A filter read from the URL. Absent means the section's default; present but empty means the
 * reader chose "All" and that choice must survive the next click.
 */
export function filterParam(value: string | undefined, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  return value.trim() || null;
}
