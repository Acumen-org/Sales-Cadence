import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, canApproveCampaign } from '@/lib/auth/rbac';
import { listCampaigns } from '@/lib/campaigns-query';
import { approveCampaignAction, rejectCampaignAction } from '@/lib/actions/campaigns';
import { ActionButton } from '@/components/action-form';
import { IconPlus } from '@/components/icons';
import { Badge, EmptyState, RecordFields, Surface, ViewHeader } from '@/components/ui';
const label = (status:string) => ({ACTIVE:'Running',PENDING_APPROVAL:'Needs approval',SCHEDULED:'Scheduled',PAUSED:'Paused',STOPPED:'Stopped',COMPLETED:'Completed',DRAFT:'Draft'}[status] ?? status);
export default async function CampaignsPage() {
 const user=await requireUser(); const all=await listCampaigns(user); const requests=all.filter(c=>c.status==='PENDING_APPROVAL'); const campaigns=all.filter(c=>c.status!=='PENDING_APPROVAL');
 return <div className="space-y-5 px-6 pb-8 pt-2">
   {requests.length>0 && <Surface flush><ViewHeader title="Needs approval" meta={<strong>{requests.length}</strong>}/><div className="divide-y divide-line">{requests.map(c=><div key={c.id} className="space-y-4 p-5"><Link href={'/campaigns/'+c.id} className="text-lg font-semibold hover:text-brand-700">{c.name}</Link><RecordFields items={[{label:'Pod',value:c.podName},{label:'Sequence',value:c.sequenceName},{label:'Requested start',value:c.startDate}]}/><div className="flex gap-2">{canApproveCampaign(user,c.podId) && <><ActionButton action={approveCampaignAction} payload={{campaignId:c.id}} className="btn-primary btn-sm">Approve</ActionButton><ActionButton action={rejectCampaignAction} payload={{campaignId:c.id}}>Decline</ActionButton></>}<Link href={'/campaigns/'+c.id} className="btn-secondary btn-sm">Review audience</Link></div></div>)}</div></Surface>}
   <Surface flush><ViewHeader title="Campaigns" meta={<strong>{campaigns.length}</strong>} actions={canEnroll(user) ? <Link href="/campaigns/new" className="btn-primary"><IconPlus size={14}/>New campaign</Link>:null}/>
   {!campaigns.length ? <EmptyState title="No campaigns"/> : <div className="overflow-x-auto"><table className="table"><thead><tr><th>Campaign</th><th>Status</th><th>Pod</th><th>Sequence</th><th>Start</th><th>People</th><th>Replied</th><th>Meetings</th><th>Reply rate</th></tr></thead><tbody>{campaigns.map(c=><tr key={c.id}><td><Link href={'/campaigns/'+c.id} className="font-semibold hover:text-brand-700">{c.name}</Link></td><td><Badge tone={c.status==='ACTIVE'?'green':c.status==='PAUSED'?'amber':'gray'}>{label(c.status)}</Badge></td><td>{c.podName}</td><td><Link href={'/sequences/'+c.sequenceId}>{c.sequenceName}</Link></td><td>{c.startDate}</td><td>{c.counts.total}</td><td>{c.counts.replied}</td><td>{c.counts.meeting}</td><td>{Math.round(c.replyRate*100)}%</td></tr>)}</tbody></table></div>}
   </Surface>
 </div>;
}
