import { sortDirection } from '@/lib/sorting';
import { personTagOptions } from '@/lib/people-options';
import { peopleWithoutAccountWhere } from '@/lib/accounts-query';
import { PageFrame } from '@/components/page-frame';
import { needsPod } from '@/lib/auth/rbac';
import Link from 'next/link';
import { personSearchWhere } from '@/lib/search-terms';
import { filterParam, sectionDefaults } from '@/lib/default-filters';
import { SyncNowButton } from '@/components/settings/sync-now-button';
import { foPeopleWhere, peopleScopeWhere } from '@/lib/people-scope';
import { campaignChoices, campaignMemberWhere, membershipFor, membershipLabel, primaryMembership } from '@/lib/campaign-membership';
import type { Prisma } from '@prisma/client';
import { requireUser } from '@/lib/auth/current-user';
import { visiblePodIds } from '@/lib/auth/rbac';
import { canRate, isMip, mipStarsFor, ratablePodOwners } from '@/lib/mip';
import { prisma } from '@/lib/db';
import { formatLocalDate } from '@/lib/dates';
import { cachedPersonName } from '@/lib/person-cache';
import { getTwentyConnection } from '@/lib/settings';
import { twentyPersonUrl } from '@/lib/twenty/urls';
import { PeopleToolbar } from '@/components/people/people-toolbar';
import { PeopleTable, type PeopleTableRow } from '@/components/people/people-table';
import { IconPeople } from '@/components/icons';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { compareLocalDates, todayIn } from '@/lib/dates';
import { contactWarnings, crmStanding, EmptyState, Surface, Toolbar, ViewHeader } from '@/components/ui';
import { parseSteps } from '@/lib/sequences/steps';

const PAGE_SIZE = 100;

type Search = { tag?: string; listCategory?: string; dir?: string; q?: string; pod?: string; fo?: string; product?: string; sort?: string; status?: string; page?: string; owner?: string; tier?: string; type?: string; account?: string; campaign?: string; mip?: string };
const SORTS = ['name', 'company', 'tier', 'recent'] as const;
type Sort = (typeof SORTS)[number];

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const defaults = await sectionDefaults(user);
  const pod = filterParam(sp.pod, defaults.podOwnerValue) ?? '';
  const fo = filterParam(sp.fo, defaults.foUserId) ?? '';
  const sort: Sort = SORTS.includes(sp.sort as Sort) ? (sp.sort as Sort) : 'name';
  const status = sp.status ?? '';
  const dir = sortDirection(sp.dir, sort === 'recent' ? 'desc' : 'asc');
  const tag = sp.tag ?? '';
  const listCategory = sp.listCategory ?? '';
  const tags = await personTagOptions();
  // Only values the mapping knows are accepted, so a hand-edited URL cannot filter on nonsense.
  const values = defaultTwentySchema.personValues;
  const pick = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : '');
  const tier = pick(sp.tier, values.tier);
  const contactType = pick(sp.type, values.contactType);
  const product = pick(sp.product, values.productInterest);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const where: Prisma.PersonCacheWhereInput = await peopleScopeWhere(user);
  const and: Prisma.PersonCacheWhereInput[] = (where.AND as Prisma.PersonCacheWhereInput[]) ?? [];
  const search = personSearchWhere(q);
  if (search) and.push(search);
  if (pod) where.podOwner = pod;
  if (fo) {
    const member = await prisma.user.findUnique({ where: { id: fo }, select: { twentyMemberId: true } });
    and.push(foPeopleWhere(fo, member?.twentyMemberId));
  }
  // People with no company in Twenty, reached from the Accounts tile that counts them.
  const account = sp.account === 'none' ? 'none' : '';
  if (account === 'none') and.push(await peopleWithoutAccountWhere());
  // One campaign's people, before or after it launched; the bulk bar can take them out of it.
  const campaignChoicesList = await campaignChoices(user);
  const campaign = campaignChoicesList.find((c) => c.id === sp.campaign)?.id ?? '';
  if (campaign) and.push(await campaignMemberWhere(campaign));
  if (tag) and.push({ tags: { has: tag } });
  // Most-important people: Twenty's MIP tag, one switch.
  const mip = sp.mip === '1';
  if (mip) and.push({ tags: { hasSome: tags.filter(tag => isMip([tag])) } });
  if (listCategory) and.push({ listCategory });
  if (product) and.push({ productInterest: { has: product } });
  if (tier) where.tier = tier;
  if (contactType) where.contactType = { has: contactType };
  if (status === 'enrolled' || status === 'approaching') where.enrollments = { some: { status: { in: ['ACTIVE', 'PAUSED'] } } };
  if (status === 'not_enrolled' || status === 'cold') {
    where.enrollments = { none: {} };
    where.dnd = false;
    where.optedOut = false;
  }
  if (status === 'replied') where.enrollments = { some: { status: { in: ['REPLIED', 'MEETING'] } } };
  if (status === 'unresponsive') and.push({ enrollments: { some: { status: 'COMPLETED' } } }, { enrollments: { none: { status: { in: ['ACTIVE', 'PAUSED', 'REPLIED', 'MEETING'] } } } });
  if (status === 'dnd') and.push({ OR: [{ dnd: true }, { optedOut: true }] });
  if (status === 'bad_data')
    and.push({
      OR: [
        { badEmail: true },
        { badPhone: true },
        { emailMissing: true },
        { phoneMissing: true },
        { enrollments: { some: { status: 'EXITED', exitReason: { in: ['bounced', 'bad_data'] } } } },
      ],
    });
  if (and.length) where.AND = and;

  const [people, total, pods, conn] = await Promise.all([
    prisma.personCache.findMany({
      where,
      // Nameless records (imports with only an address) sort after everyone with a name; they
      // used to fill the first pages of the directory.
      orderBy: [...(sort === 'company' ? [{ companyName: { sort: dir, nulls: 'last' as const } }] : sort === 'tier' ? [{ tier: { sort: dir, nulls: 'last' as const } }] : sort === 'recent' ? [{ twentyUpdatedAt: { sort: dir, nulls: 'last' as const } }] : []), { sortName: { sort: dir, nulls: 'last' } }, { email: { sort: dir, nulls: 'last' } }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        enrollments: { orderBy: { createdAt: 'desc' }, take: 1, include: { fo: { select: { id: true, name: true } }, pod: { select: { id: true, name: true } }, campaign: { select: { id: true, name: true } }, sequence: { select: { name: true, steps: true } } } },
      },
    }),
    prisma.personCache.count({ where }),
    prisma.pod.findMany({ orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true, role: true } } } } } }),
    getTwentyConnection(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    p.set('pod', pod);
    p.set('fo', fo);
    p.set('dir', dir);
    if (tag) p.set('tag', tag);
    if (listCategory) p.set('listCategory', listCategory);
    if (account) p.set('account', account);
    if (campaign) p.set('campaign', campaign);
    if (product) p.set('product', product);
    if (sort !== 'name') p.set('sort', sort);
    if (status) p.set('status', status);
    if (tier) p.set('tier', tier);
    if (contactType) p.set('type', contactType);
    p.set('page', String(n));
    return `/people?${p.toString()}`;
  };

  const today = todayIn(user.timezone);
  const podByOwner = new Map(pods.map((x) => [x.podOwnerValue, x]));
  // The filters offer the pods this reader can see and the active people in them.
  const visible = visiblePodIds(user);
  const visiblePodRows = pods.filter((x) => visible === null || visible.includes(x.id));
  const fos = [...new Map(visiblePodRows.flatMap((x) => x.users.filter((up) => up.user.active && needsPod(up.user.role)).map((up) => [up.user.id, { id: up.user.id, name: up.user.name }] as const))).values()].sort((a, b) => a.name.localeCompare(b.name));

  const [membership, stars, ratable] = await Promise.all([membershipFor(people.map((p) => p.id)), mipStarsFor(people.map((p) => p.id)), ratablePodOwners(user)]);
  const rows: PeopleTableRow[] = people.map((p) => {
    const e = p.enrollments[0] ?? null;
    const active = e && (e.status === 'ACTIVE' || e.status === 'PAUSED') ? e : null;
    const shown = primaryMembership(membership.get(p.id));
    const shownLabel = shown ? membershipLabel(shown) : null;
    const cadencePod = p.podOwner ? podByOwner.get(p.podOwner) ?? null : null;
    return {
      id: p.id,
      name: cachedPersonName(p),
      jobTitle: p.jobTitle,
      companyName: p.companyName,
      podName: cadencePod?.name ?? null,
      podId: cadencePod?.id ?? null,
      standing: crmStanding(p),
      tier: p.tier,
      listCategory: p.listCategory,
      leadSource: p.leadSource,
      tags: p.tags,
      warnings: contactWarnings(p),
      next:
        p.nextAction || p.nextActionDueDate
          ? {
              action: p.nextAction,
              due: p.nextActionDueDate ? formatLocalDate(p.nextActionDueDate) : null,
              step: p.nextStep,
              overdue: Boolean(p.nextActionDueDate && compareLocalDates(p.nextActionDueDate, today) < 0),
            }
          : null,
      dnd: p.dnd,
      optedOut: p.optedOut,
      campaign: shown && shownLabel ? { id: shown.campaignId, name: shown.campaignName, label: shownLabel.label, tone: shownLabel.tone } : null,
      inCampaign: Boolean(shown && shown.kind !== 'finished'),
      mip: isMip(p.tags),
      stars: stars.get(p.id) ?? 0,
      canRate: canRate(ratable, p.podOwner),
      // A sequence without a campaign (a direct enrollment) still shows where the person is in it.
      sequence: shown ? { id: shown.sequenceId, name: shown.sequenceName, step: shown.step, steps: shown.steps } : e ? { id: e.sequenceId, name: e.sequence.name, step: e.currentStep >= 0 ? e.currentStep : null, steps: parseSteps(e.sequence.steps).length } : null,
      foName: active?.fo.name ?? null,
      activeEnrollmentId: active?.id ?? null,
      twentyUrl: twentyPersonUrl(conn.baseUrl, p.id),
    };
  });

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title={q || pod || status || fo || product || tag || listCategory || tier || contactType || account || campaign ? 'Filtered people' : 'All people'}
          caret
          meta={`${total} result${total === 1 ? '' : 's'}`}
          actions={<SyncNowButton />}
        />
        <Toolbar>
          <PeopleToolbar
            pods={visiblePodRows.map((p) => ({ podOwnerValue: p.podOwnerValue, name: p.name }))}
            fos={fos}
            products={[...values.productInterest]}
            tiers={[...values.tier]}
            types={[...values.contactType]}
            q={q}
            pod={pod}
            fo={fo}
            product={product}
            sort={sort} dir={dir} tag={tag} tags={tags} listCategory={listCategory} mip={mip}
            campaigns={campaignChoicesList.map((c) => ({ id: c.id, name: c.name, kind: c.kind }))}
            campaign={campaign}
            status={status}
            tier={tier}
            type={contactType}
          />
        </Toolbar>
        {rows.length === 0 ? (
          <EmptyState icon={<IconPeople size={20} />} title="No people match" hint="Adjust the filters to find a contact." />
        ) : (
          <PeopleTable rows={rows} />
        )}
      </Surface>

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
