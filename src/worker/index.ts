import 'dotenv/config';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { SYSTEM_ACTOR } from '../lib/audit';
import { purgeExpiredSessions } from '../lib/auth/session-purge';
import { runSchedulerTick } from '../lib/engine/tasks';
import { launchScheduledCampaigns } from '../lib/engine/campaigns';
import { syncContinuously } from '../lib/continuous-sync';
import { reconcile } from '../lib/engine/reconcile';
import { refreshPersonCache } from '../lib/person-cache';
import { getTwentyClient } from '../lib/twenty';
import { todayIn } from '../lib/dates';
import { WORKSPACE_TIMEZONE } from '../lib/workspace';

const config=env();
const log=(message:string,extra?:unknown)=>console.log('[worker '+new Date().toISOString()+'] '+message,extra??'');
let running=false;let lastSync=0;let lastPurge=0;let stopping=false;
/**
 * The nightly catch-up, which the docs have always promised and nothing ran: continuous sync
 * follows a watermark, so an event Twenty never delivered is never noticed. Once a day, in the
 * small hours of the workspace's own clock, the last few days of activity are re-scanned and the
 * person cache is refreshed in full. `lastNightly` is the calendar day it last ran, so a restart
 * does not repeat it and a missed day is picked up at the next tick after the hour.
 */
let lastNightly:string|null=null;
/** The day the last reconcile actually ran, from its own audit row, so a restart does not repeat it. */
async function nightlyAlreadyRan(now:Date):Promise<boolean>{
 const row=await prisma.auditLog.findFirst({where:{entityType:'settings',entityId:'reconcile',action:'reconcile_ran'},orderBy:{createdAt:'desc'},select:{createdAt:true}});
 return Boolean(row&&todayIn(WORKSPACE_TIMEZONE,row.createdAt)===todayIn(WORKSPACE_TIMEZONE,now));
}
async function nightly(now:Date){
 const today=todayIn(WORKSPACE_TIMEZONE,now);
 if(lastNightly===today)return;
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:WORKSPACE_TIMEZONE,hour:'2-digit',hour12:false}).format(now));
 if(hour<config.RECONCILE_HOUR)return;
 if(await nightlyAlreadyRan(now)){lastNightly=today;return;}
 lastNightly=today;
 try{const stats=await reconcile({actor:SYSTEM_ACTOR,now});log('nightly reconcile',stats);}catch(error){log('nightly reconcile failed',error);}
 if(config.CACHE_REFRESH_HOUR<=hour){
   try{const stats=await refreshPersonCache(await getTwentyClient());log('cache refresh',stats);}catch(error){log('cache refresh failed',error);}
 }
}
async function tick(){
 if(running||stopping)return;running=true;
 try{
   const now=Date.now();
   if(now-lastSync>=config.CRM_SYNC_SECONDS*1000){
     try{await syncContinuously();lastSync=now;}catch(error){log('CRM sync failed',error);}
   }
   await nightly(new Date(now));
   await launchScheduledCampaigns({actor:SYSTEM_ACTOR});
   const stats=await runSchedulerTick({actor:SYSTEM_ACTOR});
   if(stats.generated||stats.completed)log('scheduler',stats);
   if(now-lastPurge>=3600000){await purgeExpiredSessions();lastPurge=now;}
 }catch(error){log('tick failed',error);}finally{running=false;}
}
async function main(){
 log('Continuous sync every '+config.CRM_SYNC_SECONDS+' seconds; nightly reconcile after '+config.RECONCILE_HOUR+':00 '+WORKSPACE_TIMEZONE);
 await tick();const timer=setInterval(tick,Math.min(config.WORKER_TICK_SECONDS,config.CRM_SYNC_SECONDS)*1000);
 const stop=async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,100));await prisma.$disconnect();process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(error=>{console.error('[worker] fatal',error);process.exit(1);});
