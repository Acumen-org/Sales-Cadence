import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { previewCampaignCalendar, saveCampaignCalendar } from '@/lib/campaign-planning-service';
import type { CampaignDraft } from '@/lib/campaign-planner';
import type { SessionUser } from '@/lib/auth/current-user';
import { activateCampaign, changeCampaignStatus } from '@/lib/engine/campaigns';
import { advanceEnrollment, completeTask } from '@/lib/engine/tasks';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { membershipFor } from '@/lib/campaign-membership';

describe('published campaign execution', () => {
  let b: Basics, user: SessionUser, d: CampaignDraft;
  beforeEach(async () => {
    await resetDb(); b = await seedBasics(); user = { ...b.users.ria, podIds:[], pods:[] };
    await prisma.personCache.updateMany({ where: { id: { in:['person-01','person-02','person-03','person-04'] } }, data: { ownerMemberId:b.users.alisa.twentyMemberId, podOwner:'ALISA',dnd:false,optedOut:false } });
    d = { name:'Calendar',podId:b.pods.Alisa.id,startDate:'2027-01-04',endDate:'2027-01-08',productInterest:['PHH'],defaultBatchSize:1,fos:[{id:b.users.alisa.id,batchSize:1}], personIds:['person-01','person-02','person-03','person-04'],assignments:{},flows:[{id:'default',name:'Default',steps:[{id:'first',day:1,actions:[{id:'email',type:'EMAIL',label:'Email',template:'Hi {{firstName}}'},{id:'call',type:'CALL',label:'Call'}]},{id:'second',day:2,actions:[{id:'email2',type:'EMAIL',label:'Follow up'}]}]}] };
  });
  it('persists and executes exactly the reviewed dates, waiting for BOTH activities', async () => {
    const preview = await previewCampaignCalendar(d,user); expect(preview.calendar.valid).toBe(true);
    const c = await saveCampaignCalendar(d,user,{publish:true,fingerprint:preview.fingerprint});
    const now = new Date('2027-01-04T16:00:00Z');
    const results = await Promise.all(Array.from({length:8},()=>activateCampaign(c.id,{actor:SYSTEM_ACTOR,now,skipSync:true})));
    expect(results.reduce((n,r)=>n+r.enrolled,0)).toBe(4);
    expect(await prisma.enrollment.count({where:{campaignId:c.id}})).toBe(4);
    const first = await prisma.enrollment.findFirstOrThrow({where:{campaignId:c.id,startDate:'2027-01-04'},include:{tasks:true}});
    expect(first.tasks).toHaveLength(2);expect(first.scheduleDates).toEqual(['2027-01-04','2027-01-05']);
    const next = new Date('2027-01-05T16:00:00Z');
    await completeTask({taskId:first.tasks[0].id,source:'MANUAL'},{actor:SYSTEM_ACTOR,now:next,skipSync:true});
    expect(await prisma.task.count({where:{enrollmentId:first.id}})).toBe(2);
    await completeTask({taskId:first.tasks[1].id,source:'MANUAL'},{actor:SYSTEM_ACTOR,now:next,skipSync:true});
    const generated = await prisma.task.findFirstOrThrow({where:{enrollmentId:first.id,stepIndex:1}});expect(generated.dueDate).toBe('2027-01-05');
    await expect(saveCampaignCalendar(d,user,{id:c.id,revision:c.updatedAt.toISOString()})).rejects.toThrow(/started/);
  });
  it('does not use global daily caps or other campaign workload', async () => {
    await prisma.user.update({where:{id:b.users.alisa.id},data:{dailyCap:1}});
    const p = await previewCampaignCalendar(d,user);const c=await saveCampaignCalendar(d,user,{publish:true,fingerprint:p.fingerprint});
    await activateCampaign(c.id,{actor:SYSTEM_ACTOR,now:new Date('2027-01-04T16:00:00Z'),skipSync:true});
    const tasks=await prisma.task.findMany({where:{enrollment:{campaignId:c.id}}});expect(tasks).toHaveLength(2);expect(new Set(tasks.map(t=>t.dueDate))).toEqual(new Set(['2027-01-04']));
  });
  it('invalidates stale previews, rejects unauthorized writes and protects concurrent edits', async () => {
    const p=await previewCampaignCalendar(d,user);
    await expect(saveCampaignCalendar({...d,endDate:'2027-01-09'},user,{publish:true,fingerprint:p.fingerprint})).rejects.toThrow(/review/);
    await expect(saveCampaignCalendar(d,{...user,role:'BIZ_OPS'},{publish:false})).rejects.toThrow(/cannot/);
    const c=await saveCampaignCalendar(d,user,{});
    const updated=await saveCampaignCalendar({...d,name:'Revised'},user,{id:c.id,revision:c.updatedAt.toISOString()});expect(updated.status).toBe('DRAFT');
    await expect(saveCampaignCalendar(d,user,{id:c.id,revision:c.updatedAt.toISOString()})).rejects.toThrow(/Someone changed/);
  });
  it('refuses duplicate campaign membership atomically and never partially launches an invalid audience', async () => {
    const p=await previewCampaignCalendar(d,user);
    const attempts=await Promise.allSettled(Array.from({length:4},()=>saveCampaignCalendar(d,user,{publish:true,fingerprint:p.fingerprint})));
    expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const c=await prisma.campaign.findFirstOrThrow({where:{plannerDraft:{not:undefined}}});
    await prisma.personCache.update({where:{id:'person-01'},data:{optedOut:true}});
    await expect(activateCampaign(c.id,{actor:SYSTEM_ACTOR,now:new Date('2027-01-04T16:00:00Z'),skipSync:true})).rejects.toThrow(/audience or team changed/);
    expect(await prisma.enrollment.count({where:{campaignId:c.id}})).toBe(0);
  });
  it('carries contact-specific outreach through membership and task generation', async () => {
    d.flows.push({...structuredClone(d.flows[0]),id:'custom',name:'Client follow-up'});d.assignments['person-01']='custom';
    const p=await previewCampaignCalendar(d,user);expect(p.calendar.valid).toBe(true);
    const c=await saveCampaignCalendar(d,user,{publish:true,fingerprint:p.fingerprint});
    expect((await membershipFor(['person-01'])).get('person-01')?.[0].sequenceName).toBe('Client follow-up');
    await activateCampaign(c.id,{actor:SYSTEM_ACTOR,now:new Date('2027-01-04T16:00:00Z'),skipSync:true});
    const e=await prisma.enrollment.findFirstOrThrow({where:{campaignId:c.id,personId:'person-01'},include:{sequence:true}});expect(e.sequence.name).toBe('Client follow-up');
    const result=await advanceEnrollment(e.id,{actor:SYSTEM_ACTOR,now:new Date('2027-01-04T16:00:00Z'),skipSync:true});expect(result.outcome).toBe('waiting');
  });
  it('requires review after CRM ownership changes and never partially launches', async () => {
    const p = await previewCampaignCalendar(d, user);
    const c = await saveCampaignCalendar(d, user, { publish: true, fingerprint: p.fingerprint });
    await prisma.personCache.update({ where: { id: 'person-01' }, data: { ownerMemberId: null } });
    await expect(activateCampaign(c.id, { actor: SYSTEM_ACTOR, now: new Date('2027-01-04T16:00:00Z'), skipSync: true })).rejects.toThrow(/ownership/);
    expect(await prisma.enrollment.count({ where: { campaignId: c.id } })).toBe(0);
  });
  it('never generates overdue follow-ups on weekends or after the campaign end', async () => {
    const p = await previewCampaignCalendar(d, user);
    const c = await saveCampaignCalendar(d, user, { publish: true, fingerprint: p.fingerprint });
    await activateCampaign(c.id, { actor: SYSTEM_ACTOR, now: new Date('2027-01-04T16:00:00Z'), skipSync: true });
    const e = await prisma.enrollment.findFirstOrThrow({ where: { campaignId: c.id, startDate: d.startDate } });
    await prisma.task.updateMany({ where: { enrollmentId: e.id }, data: { state: 'DONE', completedAt: new Date('2027-01-09T16:00:00Z') } });
    for (const date of ['2027-01-09', '2027-01-11']) expect((await advanceEnrollment(e.id, { actor: SYSTEM_ACTOR, now: new Date(date + 'T16:00:00Z'), skipSync: true })).outcome).toBe('waiting');
    expect(await prisma.task.count({ where: { enrollmentId: e.id } })).toBe(2);
  });
  it('keeps draft flow rows private and stable across saves, and forbids expired resumes', async () => {
    const c = await saveCampaignCalendar(d, user, {});
    const updated = await saveCampaignCalendar(d, user, { id: c.id, revision: c.updatedAt.toISOString() });
    expect(updated.sequenceId).toBe(c.sequenceId);
    expect(await prisma.sequence.count({ where: { campaignOwned: true } })).toBe(1);
    const p = await previewCampaignCalendar(d, user, c.id);
    await saveCampaignCalendar(d, user, { id: c.id, revision: updated.updatedAt.toISOString(), publish: true, fingerprint: p.fingerprint });
    await changeCampaignStatus(c.id, 'PAUSED', SYSTEM_ACTOR, new Date('2027-01-03T16:00:00Z'));
    await expect(changeCampaignStatus(c.id, 'ACTIVE', SYSTEM_ACTOR, new Date('2027-01-09T16:00:00Z'))).rejects.toThrow(/window has ended/);
  });
});
