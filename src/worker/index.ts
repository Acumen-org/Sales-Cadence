import 'dotenv/config';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { SYSTEM_ACTOR } from '../lib/audit';
import { purgeExpiredSessions } from '../lib/auth/session-purge';
import { runSchedulerTick } from '../lib/engine/tasks';
import { launchScheduledCampaigns } from '../lib/engine/campaigns';
import { syncContinuously } from '../lib/continuous-sync';

const config=env();
const log=(message:string,extra?:unknown)=>console.log('[worker '+new Date().toISOString()+'] '+message,extra??'');
let running=false;let lastSync=0;let lastPurge=0;let stopping=false;
async function tick(){
 if(running||stopping)return;running=true;
 try{
   const now=Date.now();
   if(now-lastSync>=config.CRM_SYNC_SECONDS*1000){
     try{await syncContinuously();lastSync=now;}catch(error){log('CRM sync failed',error);}
   }
   await launchScheduledCampaigns({actor:SYSTEM_ACTOR});
   const stats=await runSchedulerTick({actor:SYSTEM_ACTOR});
   if(stats.generated||stats.completed)log('scheduler',stats);
   if(now-lastPurge>=3600000){await purgeExpiredSessions();lastPurge=now;}
 }catch(error){log('tick failed',error);}finally{running=false;}
}
async function main(){
 log('Continuous sync every '+config.CRM_SYNC_SECONDS+' seconds');
 await tick();const timer=setInterval(tick,Math.min(config.WORKER_TICK_SECONDS,config.CRM_SYNC_SECONDS)*1000);
 const stop=async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,100));await prisma.$disconnect();process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(error=>{console.error('[worker] fatal',error);process.exit(1);});
