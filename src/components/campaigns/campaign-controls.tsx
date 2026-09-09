'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveCampaignAction, rejectCampaignAction, pauseCampaignAction, reenrollNonRepliersAction, restartCampaignAction, resumeCampaignAction, stopCampaignAction, type FollowupPreview } from '@/lib/actions/campaigns';
import { ActionButton, ActionForm } from '@/components/action-form';
import { Card, Field } from '@/components/ui';

type Props = { campaignId: string; status: string; sequences: {id:string;name:string}[]; currentSequenceId:string; defaultName:string; today:string };
export function CampaignControls({ campaignId,status,sequences,currentSequenceId,defaultName,today }: Props) {
 const router=useRouter(); const [preview,setPreview]=useState<FollowupPreview|null>(null);
 return <div className="space-y-4">
   {['STOPPED','COMPLETED'].includes(status) && <Card title="Restart from the beginning"><ActionForm action={restartCampaignAction} className="flex flex-wrap items-end gap-3 p-4" onSuccess={() => router.refresh()}><input type="hidden" name="campaignId" value={campaignId}/><Field label="Start date"><input type="date" name="startDate" defaultValue={today} required/></Field><button type="submit" className="btn-primary">Restart campaign</button></ActionForm></Card>}
   {status !== 'PENDING_APPROVAL' && <Card title="Follow up with non-repliers"><div onChange={() => setPreview(null)}><ActionForm action={reenrollNonRepliersAction} className="space-y-4 p-5" onSuccess={r => { if(r.redirectTo) router.push(r.redirectTo); else if(r.data) setPreview(r.data as FollowupPreview); }}>
     <input type="hidden" name="campaignId" value={campaignId}/><input type="hidden" name="confirm" value={preview ? 'yes':'no'}/>
     <div className="grid gap-4 md:grid-cols-2"><Field label="Sequence"><select name="sequenceId" defaultValue={sequences.find(s=>s.id!==currentSequenceId)?.id ?? currentSequenceId} className="w-full">{sequences.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Campaign name"><input name="name" defaultValue={defaultName} className="w-full" required/></Field><Field label="Days since completion"><input name="days" type="number" min={0} max={365} defaultValue={14} className="w-full"/></Field><Field label="Requested start date"><input name="startDate" type="date" defaultValue={today} className="w-full" required/></Field></div>
     {preview && <div className="overflow-x-auto rounded-xl border border-line"><div className="border-b border-line p-3 text-sm"><strong>{preview.candidates.length}</strong> eligible contacts</div><table className="table"><thead><tr><th>Person</th><th>Company</th><th>FO</th><th>Completed</th></tr></thead><tbody>{preview.candidates.map(c=><tr key={c.id}><td>{c.name}</td><td>{c.company ?? '—'}</td><td>{c.fo}</td><td>{c.completedAt?.slice(0,10) ?? '—'}</td></tr>)}</tbody></table>{!preview.candidates.length && <p className="p-4 text-sm">No contacts meet these conditions.</p>}</div>}
     <div className="flex gap-2"><button type="submit" className={preview ? 'btn-primary':'btn-secondary'} disabled={Boolean(preview && !preview.candidates.length)}>{preview ? 'Submit for approval':'Find who qualifies'}</button>{preview && <button type="button" className="btn-ghost" onClick={()=>setPreview(null)}>Reset preview</button>}</div>
   </ActionForm></div></Card>}
 </div>;
}

/** The campaign's own lifecycle, for the record header. */
export function CampaignLifecycle({ campaignId, status, canApprove = false }: { campaignId: string; status: string; canApprove?: boolean }) {
 return <>
   {status === 'PENDING_APPROVAL' && (canApprove ? <><ActionButton action={approveCampaignAction} payload={{campaignId}} className="btn-primary">Approve campaign</ActionButton><ActionButton action={rejectCampaignAction} payload={{campaignId}}>Decline</ActionButton></> : <span className="chip">Awaiting Sales Leader approval</span>)}
   {(status === 'ACTIVE' || status === 'SCHEDULED') && <ActionButton action={pauseCampaignAction} payload={{campaignId}}>Pause campaign</ActionButton>}
   {status === 'PAUSED' && <ActionButton action={resumeCampaignAction} payload={{campaignId}}>Resume campaign</ActionButton>}
   {['ACTIVE','PAUSED','SCHEDULED'].includes(status) && <ActionButton action={stopCampaignAction} payload={{campaignId}} className="btn-ghost text-red-700" confirm="Stop outreach for everyone in this campaign? You can restart it from the beginning later.">Stop campaign</ActionButton>}
 </>;
}
