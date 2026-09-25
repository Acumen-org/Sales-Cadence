import 'dotenv/config';
import { retryFailedWrites } from '../lib/engine/sync-retry';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { SYSTEM_ACTOR } from '../lib/audit';
import { purgeExpiredSessions } from '../lib/auth/session-purge';
import { runSchedulerTick } from '../lib/engine/tasks';
import { launchScheduledCampaigns } from '../lib/engine/campaigns';
import { syncContinuously } from '../lib/continuous-sync';
import { reconcile } from '../lib/engine/reconcile';
import { refreshPersonCache } from '../lib/person-cache';
import { snapshotScorecard } from '../lib/enrichment-work';
import { getTwentyClient } from '../lib/twenty';
import { todayIn } from '../lib/dates';
import { workspaceTimezone } from '../lib/workspace';
import { importCalendarWindow } from '../lib/meetings/calendar-import';
import { syncNextActions } from '../lib/next-actions';

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
 return Boolean(row&&todayIn(workspaceTimezone(),row.createdAt)===todayIn(workspaceTimezone(),now));
}
async function nightly(now:Date){
 const today=todayIn(workspaceTimezone(),now);
 if(lastNightly===today)return;
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:workspaceTimezone(),hour:'2-digit',hour12:false}).format(now));
 if(hour<config.RECONCILE_HOUR)return;
 if(await nightlyAlreadyRan(now)){lastNightly=today;return;}
 lastNightly=today;
 try{const stats=await reconcile({actor:SYSTEM_ACTOR,now});log('nightly reconcile',stats);}catch(error){log('nightly reconcile failed',error);}
 try{const stats=await refreshPersonCache(await getTwentyClient());log('cache refresh',stats);}catch(error){log('cache refresh failed',error);}
 try{const stats=await snapshotScorecard(now);log('enrichment scorecard snapshot',stats);}catch(error){log('enrichment scorecard snapshot failed',error);}
 // Meetings booked days ago for next week have not changed since: the calendar is read by date too.
 try{const stats=await importCalendarWindow({from:new Date(now.getTime()-7*86400000),to:new Date(now.getTime()+60*86400000)});log('calendar meetings',stats);}catch(error){log('calendar meetings failed',error);}
}
/** The first time meetings come from calendars, the last month and the next two are read at once. */
let calendarChecked=false;
async function firstCalendarImport(now:Date){
 if(calendarChecked)return;calendarChecked=true;
 if(await prisma.setting.findUnique({where:{key:'calendarFirstImport'}}))return;
 try{const stats=await importCalendarWindow({from:new Date(now.getTime()-30*86400000),to:new Date(now.getTime()+60*86400000)});log('first calendar import',stats);await prisma.setting.upsert({where:{key:'calendarFirstImport'},create:{key:'calendarFirstImport',value:{at:now.toISOString(),stats}},update:{value:{at:now.toISOString(),stats}}});}catch(error){log('first calendar import failed',error);}
}
async function tick(){
 if(running||stopping)return;running=true;
 try{
   const now=Date.now();
   if(now-lastSync>=config.CRM_SYNC_SECONDS*1000){
     try{await syncContinuously();lastSync=now;}catch(error){log('CRM sync failed',error);}
   }
   await nightly(new Date(now));
   await firstCalendarImport(new Date(now));
   await launchScheduledCampaigns({actor:SYSTEM_ACTOR});
   const stats=await runSchedulerTick({actor:SYSTEM_ACTOR});
   if(stats.generated||stats.completed)log('scheduler',stats);
   const retried=await retryFailedWrites();
   if(retried.retried)log('twenty write retry',retried);
   // Next actions: what has not reached Twenty yet, and what people changed there.
   try{const na=await syncNextActions();if(na.pushed||na.failed||na.followed||na.closed)log('next actions',na);}catch(error){log('next actions failed',error);}
   if(now-lastPurge>=3600000){await purgeExpiredSessions();lastPurge=now;}
 }catch(error){log('tick failed',error);}finally{running=false;}
}
async function main(){
 log('Continuous sync every '+config.CRM_SYNC_SECONDS+' seconds; nightly reconcile after '+config.RECONCILE_HOUR+':00 '+workspaceTimezone());
 await tick();const timer=setInterval(tick,Math.min(config.WORKER_TICK_SECONDS,config.CRM_SYNC_SECONDS)*1000);
 const stop=async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,100));await prisma.$disconnect();process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(error=>{console.error('[worker] fatal',error);process.exit(1);});
