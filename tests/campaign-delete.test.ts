import {beforeEach,describe,it,expect} from 'vitest';
import {prisma} from '@/lib/db';
import {resetDb,seedBasics,type Basics} from './helpers/db';
import {deleteCampaignPermanently} from '@/lib/campaign-delete';
import type {SessionUser} from '@/lib/auth/current-user';
let b:Basics,user:SessionUser;
beforeEach(async()=>{await resetDb();b=await seedBasics();user={...b.users.ria,podIds:[],pods:[]};});
const campaign=()=>prisma.campaign.create({data:{name:'Erase this campaign',sequenceId:b.sequence.id,podId:b.pods.Alisa.id,personIds:['person-01'],startDate:'2027-01-04',status:'STOPPED'}});
describe('explicit campaign erasure',()=>{
 it('requires an admin, exact name and a non-running campaign',async()=>{const c=await campaign();await expect(deleteCampaignPermanently(c.id,c.name,{...user,role:'BIZ_OPS'})).rejects.toThrow(/admin/);await expect(deleteCampaignPermanently(c.id,'wrong',user)).rejects.toThrow(/exact/);await prisma.campaign.update({where:{id:c.id},data:{status:'ACTIVE'}});await expect(deleteCampaignPermanently(c.id,c.name,user)).rejects.toThrow(/Stop/);expect(await prisma.campaign.count()).toBe(1);});
 it('erases dependent work, audit and outbox without deleting people or another campaign',async()=>{const c=await campaign();const other=await prisma.campaign.create({data:{name:'Keep me',sequenceId:b.sequence.id,podId:b.pods.Alisa.id,startDate:'2027-02-01'}});const e=await prisma.enrollment.create({data:{campaignId:c.id,personId:'person-01',foUserId:b.users.alisa.id,sequenceId:b.sequence.id,startDate:c.startDate,status:'EXITED'}});const t=await prisma.task.create({data:{enrollmentId:e.id,foUserId:b.users.alisa.id,stepIndex:0,stepId:'s',stepDay:1,actionIndex:0,actionId:'a',action:'EMAIL',label:'Email',dueDate:c.startDate,plannedDate:c.startDate,dueAt:new Date('2027-01-04T15:00Z'),state:'CANCELLED'}});await prisma.twentyWrite.create({data:{operation:'createTask',objectType:'task',taskId:t.id,payload:{title:'Old task'},status:'FAILED'}});await prisma.touch.create({data:{personId:'person-01',channel:'EMAIL',direction:'OUTBOUND',occurredAt:new Date(),summary:'Campaign email',externalId:`task:${t.id}`}});await prisma.auditLog.create({data:{entityType:'task',entityId:t.id,action:'created',actorType:'SYSTEM',details:{campaignId:c.id}}});await deleteCampaignPermanently(c.id,c.name,user);expect(await prisma.campaign.findUnique({where:{id:c.id}})).toBeNull();expect(await prisma.campaign.findUnique({where:{id:other.id}})).not.toBeNull();expect(await prisma.task.count()).toBe(0);expect(await prisma.enrollment.count()).toBe(0);expect(await prisma.twentyWrite.count()).toBe(0);expect(await prisma.touch.count()).toBe(0);expect(await prisma.personCache.findUnique({where:{id:'person-01'}})).not.toBeNull();expect(await prisma.sequence.findUnique({where:{id:b.sequence.id}})).not.toBeNull();expect(await prisma.auditLog.count({where:{entityId:t.id}})).toBe(0);});
});
describe('deleting a draft', () => {
  const as = (u: Basics['users'][keyof Basics['users']], role: SessionUser['role'], podIds: string[]): SessionUser => ({ ...u, role, podIds, pods: podIds.map((id) => ({ id, name: id })) });
  const make = (status: 'DRAFT' | 'PENDING_APPROVAL' | 'SCHEDULED' | 'STOPPED' | 'COMPLETED', name = 'JJJ') => prisma.campaign.create({ data: { name, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: ['person-01'], startDate: '2027-01-04', status } });
  it('lets the pod’s leaders delete a draft or one waiting for approval, and nobody else in the pod', async () => {
    const leader = as(b.users.alisa, 'SENIOR_FO', [b.pods.Alisa.id]);
    const own = await prisma.sequence.create({ data: { name: 'Private', campaignOwned: true, steps: [] } });
    const draft = await prisma.campaign.create({ data: { name: 'JJJ', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: ['person-01'], startDate: '2027-01-04', status: 'DRAFT', plannerDraft: { sequenceIds: { default: own.id } } } });
    for (const who of [as(b.users.karson, 'JUNIOR_FO', [b.pods.Alisa.id]), as(b.users.leigh, 'SENIOR_FO', [b.pods.Leigh.id]), as(b.users.leigh, 'POD_MANAGER', [b.pods.Leigh.id]), as(b.users.daniel, 'BIZ_OPS', [])]) {
      await expect(deleteCampaignPermanently(draft.id, 'JJJ', who)).rejects.toThrow('You cannot delete campaigns in this pod.');
    }
    await expect(deleteCampaignPermanently(draft.id, 'jjj', leader)).rejects.toThrow(/exact/);
    await deleteCampaignPermanently(draft.id, 'JJJ', leader);
    expect(await prisma.campaign.findUnique({ where: { id: draft.id } })).toBeNull();
    // Its private outreach goes with it; the shared sequence stays.
    expect(await prisma.sequence.findUnique({ where: { id: own.id } })).toBeNull();
    expect(await prisma.sequence.findUnique({ where: { id: b.sequence.id } })).not.toBeNull();
    const waiting = await make('PENDING_APPROVAL', 'Waiting');
    await deleteCampaignPermanently(waiting.id, 'Waiting', as(b.users.leigh, 'POD_MANAGER', [b.pods.Alisa.id]));
    expect(await prisma.campaign.count({ where: { id: waiting.id } })).toBe(0);
    const another = await make('DRAFT', 'Another');
    await deleteCampaignPermanently(another.id, 'Another', as(b.users.leigh, 'SALES_LEADER', [b.pods.Alisa.id]));
    expect(await prisma.campaign.count({ where: { id: another.id } })).toBe(0);
  });
  it('keeps anything published or already run for an admin', async () => {
    const leader = as(b.users.alisa, 'SALES_LEADER', [b.pods.Alisa.id]);
    for (const status of ['SCHEDULED', 'STOPPED', 'COMPLETED'] as const) {
      const c = await make(status, status);
      await expect(deleteCampaignPermanently(c.id, status, leader)).rejects.toThrow('Only an admin can delete a campaign that has been published.');
    }
    const ran = await make('DRAFT', 'Ran before');
    await prisma.enrollment.create({ data: { campaignId: ran.id, personId: 'person-01', foUserId: b.users.alisa.id, sequenceId: b.sequence.id, startDate: ran.startDate, status: 'EXITED' } });
    await expect(deleteCampaignPermanently(ran.id, 'Ran before', leader)).rejects.toThrow('This campaign has run before, so only an admin can delete it.');
    await deleteCampaignPermanently(ran.id, 'Ran before', user);
    expect(await prisma.campaign.count({ where: { id: ran.id } })).toBe(0);
    // An admin deletes a draft too, but never a scheduled or running one.
    await deleteCampaignPermanently((await make('DRAFT', 'Admin draft')).id, 'Admin draft', user);
    const scheduled = await prisma.campaign.findFirstOrThrow({ where: { status: 'SCHEDULED' } });
    await expect(deleteCampaignPermanently(scheduled.id, scheduled.name, user)).rejects.toThrow(/Stop/);
  });
});
