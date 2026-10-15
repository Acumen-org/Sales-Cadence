'use client';

import { useRouter } from 'next/navigation';
import { NextActionButton } from '@/components/people/next-action-form';

/**
 * Create a task from Tasks: find the person, say what to do and when. Once saved, the list opens
 * on the tab its date falls in, with the new task open.
 */
export function CreateTaskButton({ today, fos, canAssign, query, selfId }: { today: string; fos: { id: string; name: string }[]; canAssign: boolean; query: string; selfId: string }) {
  const router = useRouter();
  // From Tasks it is the reader's own task unless they give it to someone else.
  const mine = canAssign && fos.some((f) => f.id === selfId) ? selfId : '';
  return (
    <NextActionButton
      today={today}
      initial={{ label: '', action: 'EMAIL', dueDate: today, repeat: 'NONE', foUserId: mine }}
      fos={fos}
      canAssign={canAssign}
      icon="plus"
      className="btn-primary"
      onDone={(_message, created) => {
        const params = new URLSearchParams(query);
        params.set('tab', created.dueDate < today ? 'overdue' : created.dueDate === today ? 'today' : 'upcoming');
        params.delete('task');
        if (created.ids[0]) params.set('next', created.ids[0]);
        router.push(`/tasks?${params.toString()}`);
      }}
    />
  );
}
