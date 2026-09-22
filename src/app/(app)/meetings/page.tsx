import { hasAiAnalysis } from '@/lib/meetings/analysis';
import { PageFrame } from '@/components/page-frame';
import Link from 'next/link';
import { optionLabel } from '@/lib/twenty/labels';
import type { Prisma } from '@prisma/client';
import { requireUser } from '@/lib/auth/current-user';
import { canCreateMeeting, ROLES_NEEDING_POD } from '@/lib/auth/rbac';
import { attendeeIsExternal, meetingReadWhere } from '@/lib/meetings-query';
import { getSettings } from '@/lib/settings';
import { prisma } from '@/lib/db';
import { addDays, formatInstant, isLocalDate, startOfLocalDay } from '@/lib/dates';
import { PRODUCTS } from '@/lib/workspace';
import { MeetingsToolbar } from '@/components/meetings/meetings-toolbar';
import { PillList } from '@/components/pill-list';
import { FavouriteButton } from '@/components/meetings/favourite-button';
import { PROVIDER_LABELS } from '@/lib/meetings/providers';
import { IconCalendar, IconExternal, IconPlus } from '@/components/icons';
import { Badge, Empty, EmptyState, IdentityCell, Surface, Toolbar, ViewHeader } from '@/components/ui';

const PAGE_SIZE = 50;

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ page?: string; who?: string; product?: string; from?: string; to?: string; fav?: string; booked?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const who = (sp.who ?? '').trim().slice(0, 120);
  const product = (PRODUCTS as readonly string[]).includes(sp.product ?? '') ? sp.product! : '';
  const from = isLocalDate(sp.from) ? sp.from! : '';
  const to = isLocalDate(sp.to) ? sp.to! : '';
  const favourites = sp.fav === '1';
  const fos = await prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const booked = fos.some((f) => f.id === sp.booked) ? sp.booked! : '';

  const readable = await meetingReadWhere(user);
  const filters: Prisma.MeetingWhereInput[] = [readable];
  // Every word must be found somewhere: the title, the account, or an attendee by the name they
  // were typed with, their address, or the CRM record they were picked from.
  for (const term of who.split(/\s+/).filter(Boolean)) {
    const has = { contains: term, mode: 'insensitive' as const };
    filters.push({ OR: [
      { title: has },
      { companyName: has },
      { attendees: { some: { OR: [{ name: has }, { email: has }, { person: { OR: [{ firstName: has }, { lastName: has }, { companyName: has }] } }] } } },
    ] });
  }
  if (product) filters.push({ products: { has: product } });
  if (from) filters.push({ occurredAt: { gte: startOfLocalDay(from, user.timezone) } });
  if (to) filters.push({ occurredAt: { lt: startOfLocalDay(addDays(to, 1), user.timezone) } });
  if (favourites) filters.push({ favourites: { some: { userId: user.id } } });
  if (booked) filters.push({ bookedById: booked });
  const where: Prisma.MeetingWhereInput = { AND: filters };
  const filtered = Boolean(who || product || from || to || favourites || booked);

  const { rules } = await getSettings();
  const externalCount = (attendees: { email: string | null; external: boolean }[]) => attendees.filter((a) => attendeeIsExternal(a, rules.internalDomains)).length;
  const [meetings, total, recordingTotal, recordings] = await Promise.all([
    prisma.meeting.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        provider: true,
        occurredAt: true,
        durationSec: true,
        companyName: true,
        companyId: true,
        products: true,
        transcript: true,
        createdBy: { select: { name: true } },
        bookedBy: { select: { name: true } },
        analysisStatus: true,
        analysis: true,
        analysisModel: true,
        _count: { select: { attendees: true } },
        attendees: { select: { email: true, external: true } },
        favourites: { where: { userId: user.id }, select: { userId: true } },
      },
    }),
    prisma.meeting.count({ where }),
    // Recordings Twenty holds on a person record. Cadence does not invent a Meeting row from
    // one, because a meeting here carries attendees and a transcript that only a human can
    // supply - so these are listed for one-click adding instead.
    prisma.personCache.count({ where: { deletedAt: null, recordingUrl: { not: null } } }),
    prisma.personCache.findMany({
      where: { deletedAt: null, recordingUrl: { not: null } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 12,
      select: { id: true, firstName: true, lastName: true, companyId: true, companyName: true, meetingUrl: true, recordingUrl: true },
    }),
  ]);
  const addedUrls = new Set(
    (await prisma.meeting.findMany({ where: { sourceUrl: { in: recordings.map((r) => r.recordingUrl ?? '').filter(Boolean) } }, select: { sourceUrl: true } })).map((m) => m.sourceUrl),
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (who) p.set('who', who);
    if (product) p.set('product', product);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (favourites) p.set('fav', '1');
    if (booked) p.set('booked', booked);
    p.set('page', String(n));
    return `/meetings?${p.toString()}`;
  };

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title="All meetings"
          caret
          meta={`${total} meeting${total === 1 ? '' : 's'}`}
          actions={
            canCreateMeeting(user) && <Link href="/meetings/new" className="btn-primary">
              <IconPlus size={14} /> Add meeting
            </Link>
          }
        />
        <Toolbar>
          <MeetingsToolbar who={who} product={product} from={from} to={to} favourites={favourites} products={PRODUCTS} booked={booked} fos={fos} />
        </Toolbar>

        {meetings.length === 0 ? (
          <EmptyState
            icon={<IconCalendar size={20} />}
            title={filtered ? 'No meetings match' : 'No meetings yet'}
            action={
              canCreateMeeting(user) && <Link href="/meetings/new" className="btn-primary">
                <IconPlus size={15} /> Add meeting
              </Link>
            }
          />
        ) : (
          <div className="min-w-0">
            <table className="table table-dense table-meetings w-full table-fixed">
              <colgroup><col className="w-10" /><col style={{width:'24%'}} /><col style={{width:'14%'}} /><col style={{width:'15%'}} /><col style={{width:'10%'}} /><col style={{width:'11%'}} /><col style={{width:'12%'}} /><col style={{width:'10%'}} /></colgroup>
              <thead>
                <tr>
                  <th aria-label="Favourite" />
                  <th>Meeting</th>
                  <th>When</th>
                  <th>Account</th>
                  <th>Products</th>
                  <th>Attendees</th>
                  <th>Content</th>
                  <th>Booked by</th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m) => (
                  <tr key={m.id}>
                    <td data-label="Favourite" className="!pr-0"><FavouriteButton meetingId={m.id} favourite={m.favourites.length > 0} compact /></td>
                    <td data-label="Meeting">
                      <IdentityCell name={m.title} href={`/meetings/${m.id}`} sub={PROVIDER_LABELS[m.provider]} />
                    </td>
                    <td data-label="When" className="text-[12.5px]"><time className="block font-semibold">{formatInstant(m.occurredAt, user.timezone)}</time>{m.durationSec ? <span className="mt-1 block text-xs text-ink-600"><strong>{Math.round(m.durationSec / 60)}</strong> min</span> : null}</td>
                    <td data-label="Account" className="break-words text-[12.5px]">
                      {m.companyId ? (
                        <Link href={`/accounts/${m.companyId}`} className="text-brand-700 hover:underline">
                          {m.companyName}
                        </Link>
                      ) : (
                        m.companyName ?? <span className="text-ink-300">-</span>
                      )}
                    </td>
                    <td data-label="Products" className="text-[12.5px]"><PillList max={1} noun="products" items={m.products.map(p => ({ label: optionLabel(p), node: <Badge tone="green">{optionLabel(p)}</Badge> }))} /></td>
                    <td data-label="Attendees" className="text-[12.5px]">
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        <span className="font-medium tabular-nums text-ink-900">{m._count.attendees}</span>
                        {externalCount(m.attendees) ? <Badge tone="green">{externalCount(m.attendees)} external</Badge> : null}
                      </div>
                    </td>
                    <td data-label="Content"><div className="flex flex-wrap gap-1">{m.transcript ? <Badge tone="blue">Transcript</Badge> : null}{hasAiAnalysis(m.analysis, m.analysisModel, m.analysisStatus) ? <Badge tone="green">Analysis</Badge> : null}{!m.transcript && !hasAiAnalysis(m.analysis, m.analysisModel, m.analysisStatus) ? <Empty /> : null}</div></td>
                    <td data-label="Booked by" className="break-words text-[12.5px]">{m.bookedBy?.name ?? <Empty />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {recordings.length ? (
        <Surface flush>
          <ViewHeader title="Recordings in Twenty" caret meta={<><span className="font-medium text-ink-900">{recordingTotal}</span> on a person record{recordingTotal > recordings.length ? <> · showing <span className="font-medium text-ink-900">{recordings.length}</span></> : null}</>} />
          <div className="min-w-0">
            <table className="table table-dense table-meetings w-full table-fixed">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Account</th>
                  <th>Links</th>
                  <th className="w-1/4"></th>
                </tr>
              </thead>
              <tbody>
                {recordings.map((b) => {
                  const url = b.recordingUrl ?? '';
                  const already = url ? addedUrls.has(url) : false;
                  return (
                    <tr key={b.id}>
                      <td data-label="Person">
                        <IdentityCell name={[b.firstName, b.lastName].filter(Boolean).join(' ') || '(no name)'} href={`/people/${b.id}`} shape="circle" />
                      </td>
                      <td data-label="Account" className="break-words text-[12.5px]">
                        {b.companyId ? (
                          <Link href={`/accounts/${b.companyId}`} className="text-brand-700 hover:underline">
                            {b.companyName}
                          </Link>
                        ) : (
                          b.companyName ?? <span className="text-ink-300">-</span>
                        )}
                      </td>
                      <td data-label="Links">
                        <div className="flex flex-wrap gap-1.5">
                          {b.meetingUrl ? (
                            <a href={b.meetingUrl} target="_blank" rel="noreferrer" className="chip-muted">
                              <IconExternal size={12} /> Join
                            </a>
                          ) : null}
                          {b.recordingUrl ? <Badge tone="blue">Recording</Badge> : null}
                        </div>
                      </td>
                      <td data-label="Action" className="text-right">
                        {already ? (
                          <span className="text-[12px] text-ink-500">Already added</span>
                        ) : (
                          canCreateMeeting(user) && <Link href={`/meetings/new?personId=${b.id}`} className="btn-secondary btn-sm !whitespace-normal">
                            <IconPlus size={12} /> Add with recording
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      ) : null}

      {pages > 1 ? (
        <div className="flex items-center justify-between text-[13px] text-ink-500">
          <span>
            Page <span className="font-medium text-ink-900">{page}</span> of <span className="font-medium text-ink-900">{pages}</span>
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">
                Previous
              </Link>
            ) : null}
            {page < pages ? (
              <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </PageFrame>
  );
}
