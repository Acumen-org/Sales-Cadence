import Link from 'next/link';
import { formatLocalDate } from '@/lib/dates';
import { notFound,redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canManageCampaigns,canApproveCampaign,isAdmin } from '@/lib/auth/rbac';
import { campaignDetail } from '@/lib/campaigns-query';
import { prisma } from '@/lib/db';
import { todayIn } from '@/lib/dates';
import { cachedPersonName } from '@/lib/person-cache';
import { CampaignControls, CampaignLifecycle } from '@/components/campaigns/campaign-controls';
import { EnrollmentActions } from '@/components/campaigns/enrollment-actions';
import { IconCampaigns } from '@/components/icons';
import { Badge,CAMPAIGN_TONE,Card,Count,ENROLLMENT_TONE,RecordFields,RecordHeader,Stat,enrollmentStatusLabel } from '@/components/ui';
import { campaignStatusLabel } from '@/lib/campaign-status';

export default async function CampaignDetailPage({params}:{params:Promise<{id:string}>}) {
 const user=await requireUser();const {id}=await params;const today=todayIn(user.timezone);const detail=await campaignDetail(id,today);if(!detail) notFound();
 const {campaign,history,summary,byStep,byFo,podFos}=detail;
 if(!isAdmin(user)&&!user.podIds.includes(campaign.podId)) redirect('/campaigns');
 const manager=canManageCampaigns(user,campaign.podId);
 const [sequences,audience]=await Promise.all([prisma.sequence.findMany({where:{archived:false},select:{id:true,name:true},orderBy:{name:'asc'}}), ['PENDING_APPROVAL','SCHEDULED'].includes(campaign.status) ? prisma.personCache.findMany({where:{id:{in:campaign.personIds}},orderBy:{lastName:'asc'}}):Promise.resolve([])]);
 return <div className="space-y-5 px-6 pb-8 pt-2">
   <RecordHeader name={campaign.name} icon={<IconCampaigns size={20} />} badges={<Badge tone={CAMPAIGN_TONE[campaign.status]??'gray'}>{campaignStatusLabel(campaign.status)}</Badge>} actions={<>{manager && <CampaignLifecycle campaignId={id} status={campaign.status} canApprove={canApproveCampaign(user,campaign.podId)}/>}<Link href="/campaigns" className="btn-ghost btn-sm">All campaigns</Link></>}/>
   <div className="surface p-5"><RecordFields items={[{label:'Pod',value:campaign.pod.name},{label:'Sequence',value:<Link href={'/sequences/'+campaign.sequenceId}>{campaign.sequence.name}</Link>},{label:'Start date',value:campaign.startDate},{label:'Assignment',value:campaign.assignmentMode==='OWNER'?'Contact owner':'Round robin'},{label:'Run',value:campaign.runNumber},{label:'Note',value:campaign.notes}]}/></div>
   <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="People" value={summary.counts.total}/><Stat label="Replied" value={summary.counts.replied}/><Stat label="Meetings" value={summary.counts.meeting}/><Stat label="Reply rate" value={Math.round(summary.replyRate*100)+'%'}/></div>
   {manager && <CampaignControls campaignId={id} status={campaign.status} sequences={sequences} currentSequenceId={campaign.sequenceId} defaultName={campaign.name+' — follow-up'} today={today}/>}
   {audience.length>0 && <Card title="Proposed audience"><div className="overflow-x-auto"><table className="table"><thead><tr><th>Person</th><th>Company</th><th>Email</th></tr></thead><tbody>{audience.map(p=><tr key={p.id}><td><Link href={'/people/'+p.id}>{cachedPersonName(p)}</Link></td><td>{p.companyName??'—'}</td><td>{p.email??'Missing'}</td></tr>)}</tbody></table></div></Card>}
   {history.length>0 && <><div className="grid gap-4 xl:grid-cols-2"><Card title="Touchpoint results"><div className="overflow-x-auto"><table className="table"><thead><tr><th>Business day</th><th>Touchpoint</th><th className="num">Reached</th><th className="num">Done</th><th className="num">Replied</th><th className="num">Meetings</th></tr></thead><tbody>{byStep.map(s=><tr key={s.index}><td>{s.day}</td><td>{s.label}</td><td className="num"><Count value={s.reached} /></td><td className="num"><Count value={s.done} /></td><td className="num"><Count value={s.replied} /></td><td className="num"><Count value={s.meeting} /></td></tr>)}</tbody></table></div></Card><Card title="Team results"><div className="overflow-x-auto"><table className="table"><thead><tr><th>FO</th><th className="num">People</th><th className="num">Replied</th><th className="num">Meetings</th><th className="num">Actions done</th></tr></thead><tbody>{byFo.map(f=><tr key={f.id}><td>{f.name}</td><td className="num"><Count value={f.total} /></td><td className="num"><Count value={f.replied} /></td><td className="num"><Count value={f.meeting} /></td><td className="num"><Count value={f.doneTasks} /></td></tr>)}</tbody></table></div></Card></div>
   <Card title="Enrollment history"><div className="overflow-x-auto"><table className="table"><thead><tr><th>Person</th><th>FO</th><th>Run</th><th>Status</th><th>Started</th><th>Step</th>{manager&&<th>Manage</th>}</tr></thead><tbody>{history.map(e=><tr key={e.id}><td><Link href={'/people/'+e.personId}>{cachedPersonName(e.person)}</Link></td><td>{e.fo.name}</td><td>{e.campaignRun}</td><td><Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'}>{enrollmentStatusLabel(e)}</Badge></td><td className="whitespace-nowrap">{formatLocalDate(e.startDate)}</td><td>{e.currentStep<0?'Not started':e.currentStep+1}</td>{manager&&<td><EnrollmentActions enrollmentId={e.id} status={e.status} foUserId={e.foUserId} fos={podFos} compact/></td>}</tr>)}</tbody></table></div></Card></>}
 </div>;
}
