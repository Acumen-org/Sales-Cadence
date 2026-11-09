import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canWorkTickets } from '@/lib/tickets';

/**
 * Number checks used to be listed here; Tickets lists them now with every other Biz Ops ticket
 * (owner, 9 Nov 2026). Old links go there, or back to Meetings for anyone who does not work tickets.
 * One check still opens at /meetings/checks/[id].
 */
export default async function NumberChecksPage() {
  const user = await requireUser();
  redirect(canWorkTickets(user) ? '/tickets' : '/meetings');
}
