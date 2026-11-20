import { Tabs } from '@/components/ui';

export type MeetingsTab = 'all' | 'waiting' | 'declined';
export type MeetingsTabCounts = { decides: boolean; waiting: number; declined: number };

/**
 * Meetings' tabs (owner, 20 Nov 2026), for Sales Leaders, admins and Biz Ops: every meeting, the ones
 * with no recording waiting for a decision (not for Biz Ops, who do not decide), and the declined ones.
 * Everyone else sees Meetings as it was, with no tabs.
 */
export function MeetingsTabs({ current, counts }: { current: MeetingsTab; counts: MeetingsTabCounts }) {
  return (
    <Tabs
      current={current}
      tabs={[
        { key: 'all', label: 'All meetings', href: '/meetings' },
        ...(counts.decides ? [{ key: 'waiting', label: 'Waiting for approval', href: '/meetings/approval', count: counts.waiting }] : []),
        { key: 'declined', label: 'Declined', href: '/meetings/approval?view=declined', count: counts.declined },
      ]}
    />
  );
}
