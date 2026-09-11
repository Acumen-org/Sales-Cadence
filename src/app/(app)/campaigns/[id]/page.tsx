import Link from 'next/link';
import { formatLocalDate } from '@/lib/dates';
import { notFound,redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canManageCampaigns, canApproveCampaign, canSeeAllPods } from '@/lib/auth/rbac';
import { campaignDetail } from '@/lib/campaigns-query';
import { prisma } from '@/lib/db';
import { todayIn } from '@/lib/dates';
import { cachedPersonName } from '@/lib/person-cache';
import { CampaignControls, CampaignLifecycle } from '@/components/campaigns/campaign-controls';
import { EnrollmentActions } from '@/components/campaigns/enrollment-actions';
import { IconCampaigns } from '@/components/icons';
import { Badge,CAMPAIGN_TONE,Card,Count,ENROLLMENT_TONE,Empty,RecordFields,RecordHeader,Stat,enrollmentStatusLabel } from '@/components/ui';
import { campaignStatusLabel, enrollConflictLabel } from '@/lib/campaign-status';
import { previewEnrollment, type EnrollConflict } from '@/lib/engine/enrollment';
import { userActor } from '@/lib/audit';

export default async function CampaignDetailPage({params}:{params:Promise<{id:string}>}) {
 const user=await requireUser();const {id}=await params;const today=todayIn(user.timezone);const detail=await campaignDetail(id,today);if(!detail) notFound();
 const {campaign,history,summary,byStep,byFo,podFos}=detail;
 if(!canSeeAllPods(user)&&!user.podIds.includes(campaign.podId)) redirect('/campaigns');
 const manager=canManageCampaigns(user,campaign.podId);
 const proposed=['PENDING_APPROVAL','SCHEDULED'].includes(campaign.status);
 const [sequences,audience,preview]=await Promise.all([prisma.sequence.findMany({where:{archived:false},select:{id:true,name:true},orderBy:{name:'asc'}}), proposed ? prisma.personCache.findMany({where:{id:{in:campaign.personIds}},orderBy:{lastName:'asc'}}):Promise.resolve([]),
   // The same preview the launch will run, so an approver sees who would be left out and why.
   proposed ? previewEnrollment({ personIds: campaign.personIds, sequenceId: campaign.sequenceId, podId: campaign.podId, campaignId: id, startDate: campaign.startDate, assignment: { mode: campaign.assignmentMode === 'ROUND_ROBIN' ? 'ROUND_ROBIN' : 'OWNER' }, dailyRampPerFo: campaign.dailyRampPerFo, actor: userActor(user) }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })) : Promise.resolve(null)]);
 const previewError = preview && 'error' in preview ? preview.error : campaign.sequence.archived ? 'The sequence is archived; restore it or pick another before launch.' : null;
 const ready = preview && !('error' in preview) ? preview : null;
 const conflictFor=new Map<string,EnrollConflict>((ready?.conflicts??[]).map(c=>[c.personId,c]));
 const foFor=new Map<string,string>((ready?.candidates??[]).map(c=>[c.personId,c.foName]));
 return <div className="space-y-5 px-6 pb-8 pt-2">
   <RecordHeader name={campaign.name} icon={<IconCampaigns size={20} />} badges={<Badge tone={CAMPAIGN_TONE[campaign.status]??'gray'}>{campaignStatusLabel(campaign.status)}</Badge>} actions={<>{manager && <CampaignLifecycle campaignId={id} status={campaign.status} canApprove={canApproveCampaign(user,campaign.podId)}/>}<Link href="/campaigns" className="btn-ghost btn-sm">All campaigns</Link></>}/>
   <div className="surface p-5"><RecordFields items={[{label:'Pod',value:campaign.pod.name},{label:'Sequence',value:<Link href={'/sequences/'+campaign.sequenceId}>{campaign.sequence.name}</Link>},{label:'Start date',value:campaign.startDate},{label:'Assignment',value:campaign.assignmentMode==='OWNER'?'Contact owner':'Round robin'},{label:'Run',value:campaign.runNumber},{label:'Note',value:campaign.notes}]}/></div>
   <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="People" value={summary.counts.total}/><Stat label="Replied" value={summary.counts.replied}/><Stat label="Meetings" value={summary.counts.meeting}/><Stat label="Reply rate" value={Math.round(summary.replyRate*100)+'%'}/></div>
   {manager && <CampaignControls campaignId={id} status={campaign.status} sequences={sequences} currentSequenceId={campaign.sequenceId} defaultName={campaign.name+' — follow-up'} today={today}/>}
   {audience.length>0 && <Card title="Proposed audience" actions={previewError ? <Badge tone="red">Preview unavailable</Badge> : ready ? <span className="flex items-center gap-2 text-[12px] text-ink-500"><Badge tone="green">{ready.candidates.length} will start</Badge>{ready.conflicts.length ? <Badge tone="amber">{ready.conflicts.length} skipped</Badge> : null}</span> : undefined}>{previewError ? <div className="border-b border-line px-5 py-3 text-[13px] text-red-700">{previewError}</div> : null}{ready?.warnings.length ? <div className="border-b border-line px-5 py-3 text-[13px] text-amber-800">{ready.warnings.join(' ')}</div> : null}<div className="overflow-x-auto"><table className="table"><thead><tr><th>Person</th><th>Company</th><th>Email</th><th>FO</th><th>On launch</th></tr></thead><tbody>{audience.map(p=>{const c=conflictFor.get(p.id);return <tr key={p.id}><td><Link href={'/people/'+p.id}>{cachedPersonName(p)}</Link></td><td>{p.companyName??<Empty />}</td><td>{p.email??<Empty />}</td><td>{foFor.get(p.id)??<Empty />}</td><td>{c ? <span className="flex flex-wrap items-center gap-1.5"><Badge tone="amber">{enrollConflictLabel(c.reason)}</Badge>{c.detail && manager ? <span className="text-[12px] text-ink-500">{c.detail}</span> : null}</span> : ready ? <Badge tone="green">Starts</Badge> : <Empty />}</td></tr>;})}</tbody></table></div></Card>}
   {history.length>0 && <><div className="grid gap-4 xl:grid-cols-2"><Card title="Touchpoint results"><div className="overflow-x-auto"><table className="table"><thead><tr><th>Business day</th><th>Touchpoint</th><th className="num">Reached</th><th className="num">Done</th><th className="num">Replied</th><th className="num">Meetings</th></tr></thead><tbody>{byStep.map(s=><tr key={s.index}><td>{s.day}</td><td>{s.label}</td><td className="num"><Count value={s.reached} /></td><td className="num"><Count value={s.done} /></td><td className="num"><Count value={s.replied} /></td><td className="num"><Count value={s.meeting} /></td></tr>)}</tbody></table></div></Card><Card title="Team results"><div className="overflow-x-auto"><table className="table"><thead><tr><th>FO</th><th className="num">People</th><th className="num">Replied</th><th className="num">Meetings</th><th className="num">Actions done</th></tr></thead><tbody>{byFo.map(f=><tr key={f.id}><td>{f.name}</td><td className="num"><Count value={f.total} /></td><td className="num"><Count value={f.replied} /></td><td className="num"><Count value={f.meeting} /></td><td className="num"><Count value={f.doneTasks} /></td></tr>)}</tbody></table></div></Card></div>
   <Card title="Enrollment history"><div className="overflow-x-auto"><table className="table"><thead><tr><th>Person</th><th>FO</th><th>Run</th><th>Status</th><th>Started</th><th>Step</th>{manager&&<th>Manage</th>}</tr></thead><tbody>{history.map(e=><tr key={e.id}><td><Link href={'/people/'+e.personId}>{cachedPersonName(e.person)}</Link></td><td>{e.fo.name}</td><td>{e.campaignRun}</td><td><Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'}>{enrollmentStatusLabel(e)}</Badge></td><td className="whitespace-nowrap">{formatLocalDate(e.startDate)}</td><td>{e.currentStep<0?'Not started':e.currentStep+1}</td>{manager&&<td><EnrollmentActions enrollmentId={e.id} status={e.status} foUserId={e.foUserId} fos={podFos} compact/></td>}</tr>)}</tbody></table></div></Card></>}
 </div>;
}
