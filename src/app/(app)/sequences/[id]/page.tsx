import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/current-user';
export default async function RetiredSequencePage({ params }: { params: Promise<{id:string}> }) {
  await requireUser(); const {id} = await params;
  // N100: an old sequence link opens a CRM campaign, never a cold one that happens to share the sequence.
  const c = await prisma.campaign.findFirst({ where: { audience: 'CRM', OR: [{sequenceId:id},{enrollments:{some:{sequenceId:id}}}] }, orderBy:{createdAt:'desc'}, select:{id:true} });
  redirect(c ? `/campaigns/${c.id}` : '/campaigns');
}
