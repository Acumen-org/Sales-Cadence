import { Tabs } from '@/components/ui';

export type MeetingsTab = 'all' | 'waiting' | 'declined';
export type MeetingsTabCounts = { decides: boolean; waiting: number; declined: number };

/**
 * Meetings' tabs (owner, 20 and 21 Nov 2026), for everyone: every meeting, the ones with no recording
 * waiting for a decision, and the declined ones. Sales Leaders and admins decide; everyone else reads
 * their pods' meetings there, and the FO who booked one may add its recording link.
 */
export function MeetingsTabs({ current, counts }: { current: MeetingsTab; counts: MeetingsTabCounts }) {
  return (
    <Tabs
      current={current}
      tabs={[
        { key: 'all', label: 'All meetings', href: '/meetings' },
        { key: 'waiting', label: 'Waiting for approval', href: '/meetings/approval', count: counts.waiting },
        { key: 'declined', label: 'Declined', href: '/meetings/approval?view=declined', count: counts.declined },
      ]}
    />
  );
}
