'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import clsx from 'clsx';
import type { AccountRole } from '@prisma/client';
import { saveRelationshipAction } from '@/lib/actions/accounts';
import { ActionForm } from '@/components/action-form';
import { ActionIcon } from '@/components/icons';
import { Avatar, Badge, type BadgeTone } from '@/components/ui';

export type TreePerson = {
  id: string;
  name: string;
  jobTitle: string | null;
  reportsToId: string | null;
  accountRole: AccountRole;
  relationshipNote: string | null;
  dnd: boolean;
  optedOut: boolean;
  enrollment: { status: string; label: string; tone: BadgeTone; foName: string; stepIndex: number; steps: number } | null;
  lastTouch: string | null;
  touches: number;
};
export type TreeNode = { person: TreePerson; children: TreeNode[] };

const ROLE_TONE: Record<AccountRole, BadgeTone> = { CHAMPION: 'green', SUPPORTER: 'blue', NEUTRAL: 'gray', DETRACTOR: 'red', UNKNOWN: 'gray' };
const ROLE_LABEL: Record<AccountRole, string> = { CHAMPION: 'Champion', SUPPORTER: 'Supporter', NEUTRAL: 'Neutral', DETRACTOR: 'Detractor', UNKNOWN: 'Unknown' };
const ROLE_BAR: Record<AccountRole, string> = {
  CHAMPION: 'bg-emerald-500',
  SUPPORTER: 'bg-brand-500',
  NEUTRAL: 'bg-ink-300',
  DETRACTOR: 'bg-red-500',
  UNKNOWN: 'bg-ink-200',
};

function Card({ p, everyone, editable }: { p: TreePerson; everyone: TreePerson[]; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  return (
    <div className="w-[236px] shrink-0 overflow-hidden rounded-xl border border-line bg-white shadow-surface">
      <div className={clsx('h-[3px] w-full', ROLE_BAR[p.accountRole])} />
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <Avatar name={p.name} shape="circle" size={30} />
          <div className="min-w-0 flex-1">
            <Link href={`/people/${p.id}`} className="block truncate text-[13px] font-medium text-ink-900 hover:text-brand-700">
              {p.name}
            </Link>
            <div className="truncate text-[11.5px] text-ink-500">{p.jobTitle ?? 'Unknown title'}</div>
          </div>
          {editable ? (
            <button type="button" onClick={() => setOpen((v) => !v)} className="btn-icon-ghost h-6 w-6" title="Edit relationship" aria-label={`Edit ${p.name}`}>
              <span className="text-[15px] leading-none">⋯</span>
            </button>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Badge tone={ROLE_TONE[p.accountRole]} dot>
            {ROLE_LABEL[p.accountRole]}
          </Badge>
          {p.dnd || p.optedOut ? <Badge tone="red">no contact</Badge> : null}
          {p.enrollment ? <Badge tone={p.enrollment.tone}>{p.enrollment.label}</Badge> : <Badge tone="gray">not in a sequence</Badge>}
        </div>

        <div className="mt-2 space-y-0.5 text-[11px] text-ink-400">
          {p.enrollment ? (
            <div>
              Step {p.enrollment.stepIndex + 1}
              {p.enrollment.steps ? ` of ${p.enrollment.steps}` : ''} · {p.enrollment.foName}
            </div>
          ) : null}
          <div>{p.lastTouch ? `Last touch ${p.lastTouch}` : 'Never touched'}</div>
          {p.relationshipNote ? <div className="line-clamp-2 text-ink-500">{p.relationshipNote}</div> : null}
        </div>

        {open ? (
          <ActionForm action={saveRelationshipAction} className="mt-2 space-y-2 border-t border-line pt-2" onSuccess={() => setOpen(false)}>
            <input type="hidden" name="personId" value={p.id} />
            <label htmlFor={`${uid}-reports`} className="block text-[10.5px]">
              Reports to
            </label>
            <select id={`${uid}-reports`} name="reportsToId" defaultValue={p.reportsToId ?? '__none__'} className="!py-1 !text-[11.5px]">
              <option value="__none__">Nobody (top of the chart)</option>
              {everyone
                .filter((o) => o.id !== p.id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.jobTitle ? ` · ${o.jobTitle}` : ''}
                  </option>
                ))}
            </select>
            <label htmlFor={`${uid}-stance`} className="block text-[10.5px]">
              Stance
            </label>
            <select id={`${uid}-stance`} name="accountRole" defaultValue={p.accountRole} className="!py-1 !text-[11.5px]">
              {(Object.keys(ROLE_LABEL) as AccountRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <label htmlFor={`${uid}-note`} className="block text-[10.5px]">
              Note
            </label>
            <textarea id={`${uid}-note`} name="relationshipNote" rows={2} defaultValue={p.relationshipNote ?? ''} className="!py-1 !text-[11.5px]" />
            <div className="flex gap-1.5">
              <button type="submit" className="btn-primary btn-sm">
                Save
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Reporting chart. Pure CSS connectors, no layout library and no canvas: cheap to render and
 * it stays readable when a branch is wide (the row scrolls horizontally).
 */
function Branch({ node, everyone, editable }: { node: TreeNode; everyone: TreePerson[]; editable: boolean }) {
  return (
    <li className="flex flex-col items-center">
      <Card p={node.person} everyone={everyone} editable={editable} />
      {node.children.length ? (
        <>
          {/* stem down from this card */}
          <span className="h-5 w-px bg-ink-200" />
          <ul className="relative flex gap-5">
            {/* horizontal rail across the children */}
            {node.children.length > 1 ? <span className="absolute left-0 right-0 top-0 mx-[118px] h-px bg-ink-200" /> : null}
            {node.children.map((c) => (
              <div key={c.person.id} className="flex flex-col items-center">
                <span className="h-5 w-px bg-ink-200" />
                <Branch node={c} everyone={everyone} editable={editable} />
              </div>
            ))}
          </ul>
        </>
      ) : null}
    </li>
  );
}

export function OrgTree({ roots, orphans, everyone, editable }: { roots: TreeNode[]; orphans: TreePerson[]; everyone: TreePerson[]; editable: boolean }) {
  if (!roots.length && !orphans.length) return null;
  return (
    <div className="space-y-5">
      {roots.length ? (
        <div className="overflow-x-auto pb-2 scroll-thin">
          <ul className="flex min-w-max items-start gap-8 px-1 pt-1">
            {roots.map((r) => (
              <Branch key={r.person.id} node={r} everyone={everyone} editable={editable} />
            ))}
          </ul>
        </div>
      ) : null}

      {orphans.length ? (
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            Not placed in the chart
            <span className="rounded-full bg-canvas px-1.5 text-[11px] font-medium text-ink-500">{orphans.length}</span>
          </h3>
          <div className="flex flex-wrap gap-3">
            {orphans.map((p) => (
              <Card key={p.id} p={p} everyone={everyone} editable={editable} />
            ))}
          </div>
          {editable ? <p className="mt-2 text-[11.5px] text-ink-400">Set “reports to” on a card to place someone in the chart.</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3 text-[11.5px] text-ink-400">
        <span className="font-medium text-ink-500">Stance</span>
        {(Object.keys(ROLE_LABEL) as AccountRole[]).map((r) => (
          <span key={r} className="inline-flex items-center gap-1.5">
            <span className={clsx('h-2 w-4 rounded-full', ROLE_BAR[r])} />
            {ROLE_LABEL[r]}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5">
          <ActionIcon action="EMAIL" size={12} /> touches are on each person’s page
        </span>
      </div>
    </div>
  );
}
