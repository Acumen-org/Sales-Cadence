import { PrismaClient } from '@prisma/client';
import { DEFAULT_SEQUENCE_STEPS } from '../src/lib/sequences/default-sequence';
import { addDays, localDateToInstant, todayIn } from '../src/lib/dates';

/** Upgrade fixture only: exercise already-running campaigns without recreating the retired UI. */
export async function seedLegacyCampaign(name: string, personIds: string[]) {
  const db = new PrismaClient({ datasourceUrl: 'postgresql://postgres:postgres@localhost:5435/cadence' });
  try {
    const pod = await db.pod.findFirstOrThrow({where:{podOwnerValue:'ALISA'}});
    const fo = await db.user.findUniqueOrThrow({where:{email:'alisa@cadence.local'}});
    const sequence = await db.sequence.findFirstOrThrow({where:{campaignOwned:false}});
    const startDate=todayIn('America/Chicago');
    const c=await db.campaign.create({data:{name,podId:pod.id,sequenceId:sequence.id,startDate,endDate:addDays(startDate,60),status:'ACTIVE',personIds,productInterest:['PHH']}});
    for(const personId of personIds){
      const person=await db.personCache.findUniqueOrThrow({where:{id:personId}});
      const e=await db.enrollment.create({data:{campaignId:c.id,sequenceId:sequence.id,podId:pod.id,foUserId:fo.id,personId,companyId:person.companyId,startDate,currentStep:0,currentStepId:DEFAULT_SEQUENCE_STEPS[0].id,status:'ACTIVE'}});
      for(const [actionIndex,a] of DEFAULT_SEQUENCE_STEPS[0].actions.entries()) await db.task.create({data:{enrollmentId:e.id,foUserId:fo.id,stepIndex:0,stepId:DEFAULT_SEQUENCE_STEPS[0].id,stepDay:1,actionIndex,actionId:a.id,action:a.type,label:a.label,actionSnapshot:a,dueDate:startDate,plannedDate:startDate,dueAt:localDateToInstant(startDate,'America/Chicago',9)}});
    }
    return c.id;
  }finally{await db.$disconnect();}
}
