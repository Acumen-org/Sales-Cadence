import 'dotenv/config';
import { backfillMeetingsToCrm, meetingSchemaShape, missingMeetingTags } from '../lib/meetings/crm';
import { backfillTeamsTranscripts } from '../lib/meetings/teams-transcript';
import { MEETINGS_CHANGED_KEY, checkMeetingsInCrm } from '../lib/meetings/crm-check';
import { backfillSharePointPlayers } from '../lib/meetings/sharepoint-player';
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
import { syncNextActions } from '../lib/next-actions';
import { runMoveQueue } from '../lib/sandbox/move';
import { backfillPhoneE164, runSandboxRetention } from '../lib/sandbox/retention';
import { purgeOldPushes } from '../lib/sandbox/bellwether-api';
import { importTwilioCalls } from '../lib/calls/import';
import { runGraphMail } from '../lib/mail/graph-mail';

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
 // The outreach sandbox: contacts nobody works, moved contacts past the one-year undo window, old push keys.
 try{const stats=await runSandboxRetention(now);if(stats.removed||stats.movedCleared||stats.optedOutCleared)log('sandbox retention',stats);}catch(error){log('sandbox retention failed',error);}
 try{const purged=await purgeOldPushes(now);if(purged)log('bellwether push keys forgotten',purged);}catch(error){log('push retention failed',error);}
}
/**
 * Every 2 minutes: calls read from Twilio (read only), and the sales mailboxes read through Graph
 * when GRAPH_MAIL_ENABLED is set. Moves to the CRM go at every tick, paced under Twenty's limit.
 */
let callsAt=0;let mailAt=0;
async function sandboxJobs(now:number){
 try{const moved=await runMoveQueue({pauseMs:1500});if(moved.done||moved.failed||moved.dryRun)log('moves to CRM',moved);}catch(error){log('moves to CRM failed',error);}
 if(now>=callsAt){callsAt=now+120_000;try{const stats=await importTwilioCalls();if(stats.ran&&(stats.created||stats.forms||stats.recordings||stats.error))log('twilio import',stats);}catch(error){log('twilio import failed',error);}}
 if(now>=mailAt){mailAt=now+120_000;try{const stats=await runGraphMail();if(stats.ran&&(stats.sent||stats.replies||stats.bounces||stats.errors.length))log('graph mail',stats);}catch(error){log('graph mail failed',error);}}
}
/** Once: E.164 copies of the phones already cached, so calls and pushes match CRM people by number. */
let phoneBackfillChecked=false;
async function phoneE164Backfill(){
 if(phoneBackfillChecked)return;phoneBackfillChecked=true;
 const key='phoneE164Backfill20261103';
 if(await prisma.setting.findUnique({where:{key}}))return;
 try{const updated=await backfillPhoneE164();log('phone numbers in E.164',updated);await prisma.setting.upsert({where:{key},create:{key,value:{at:new Date().toISOString(),updated}},update:{value:{at:new Date().toISOString(),updated}}});}catch(error){log('phone backfill failed',error);}
}
/**
 * Once: the last two weeks of notes and emails are read again. Logged calls and emails whose person
 * Twenty attached a moment late were set aside as "on no contact" and never read again; now they
 * are, and each closes the step that was open when it happened.
 */
let evidenceRescanChecked=false;
async function evidenceRescan(now:Date){
 if(evidenceRescanChecked)return;evidenceRescanChecked=true;
 const key='evidenceRescan20261009';
 if(await prisma.setting.findUnique({where:{key}}))return;
 try{const stats=await reconcile({days:14,only:['notes','messages'],reread:true,actor:SYSTEM_ACTOR,now});log('evidence rescan',stats);await prisma.setting.upsert({where:{key},create:{key,value:{at:now.toISOString(),stats}},update:{value:{at:now.toISOString(),stats}}});}catch(error){log('evidence rescan failed',error);}
}
/**
 * Every meeting already in Cadence is written to Twenty again whenever what Cadence writes changes:
 * a new release (the version below) or a field the CRM admin added to Meetings or Meeting contacts.
 * Checked at start and each hour, so a field added in Twenty fills in for old meetings within one.
 */
const MEETINGS_RELEASE='20261029';
let meetingsBackfillAt=0;
async function meetingsBackfill(now:number){
 if(now<meetingsBackfillAt)return;meetingsBackfillAt=now+3_600_000;
 const key='meetingsToTwentyShape';
 try{
  const schema=await (await getTwentyClient()).meetingSchema();
  if(!schema)return;
  const shape=`${MEETINGS_RELEASE}|${meetingSchemaShape(schema)}`;
  const row=await prisma.setting.findUnique({where:{key}});
  if((row?.value as {shape?:string}|null)?.shape===shape)return;
  const written=await backfillMeetingsToCrm({all:true});if(written===null)return;
  log('meetings written to Twenty',written);
  const value={at:new Date().toISOString(),written,shape};
  await prisma.setting.upsert({where:{key},create:{key,value},update:{value}});
 }catch(error){log('meetings backfill failed',error);}
}
/**
 * Twenty holding every meeting as Cadence wrote it, numbered: every ten minutes, at the next tick
 * after Twenty reports a change to a meeting, and tick after tick while writes are still waiting
 * (src/lib/meetings/crm-check.ts).
 */
let meetingsTwentyAt=0;let meetingsTwentyRan=0;
async function meetingsWithTwenty(now:number){
 const flagged=await prisma.setting.findUnique({where:{key:MEETINGS_CHANGED_KEY}});
 const changedAt=Date.parse(String((flagged?.value as {at?:string}|null)?.at??''));
 if(now<meetingsTwentyAt&&!(changedAt>=meetingsTwentyRan))return;
 meetingsTwentyRan=now;meetingsTwentyAt=now+600_000;
 try{const stats=await checkMeetingsInCrm();if(stats&&(stats.linked||stats.written))log('meetings checked in Twenty',stats);if(stats?.waiting)meetingsTwentyAt=0;}catch(error){log('meetings check in Twenty failed',error);}
}
/** Each hour: recent Teams recordings without a transcript ask Microsoft for theirs. */
let teamsTranscriptsAt=0;
async function teamsTranscripts(now:number){
 if(now<teamsTranscriptsAt)return;teamsTranscriptsAt=now+3_600_000;
 try{const found=await backfillTeamsTranscripts();if(found)log('Teams transcripts fetched',found);}catch(error){log('Teams transcripts failed',error);}
}
// While some tag is missing in Twenty, write the meetings again each hour, so a tag an admin adds
// by hand fills in without anyone asking.
let meetingTagsRetryAt=Date.now()+3_600_000;
async function meetingTagsRetry(now:number){
 if(now<meetingTagsRetryAt)return;meetingTagsRetryAt=now+3_600_000;
 if(!(await missingMeetingTags()).length)return;
 try{const written=await backfillMeetingsToCrm({all:true});if(written!==null)log('meetings written again for missing tags',written);}catch(error){log('meetings tag retry failed',error);}
}
/**
 * Once Microsoft lets Cadence read the team's files: meetings saved earlier with a SharePoint sharing
 * link get SharePoint's player and play in Cadence too. Asked each hour until it does.
 */
let sharePointPlayersAt=0;
async function sharePointPlayers(now:number){
 if(now<sharePointPlayersAt)return;sharePointPlayersAt=now+3_600_000;
 const key='sharePointPlayers20261029';
 if(await prisma.setting.findUnique({where:{key}})){sharePointPlayersAt=Infinity;return;}
 try{const played=await backfillSharePointPlayers();if(played===null)return;log('SharePoint recordings that now play',played);await prisma.setting.upsert({where:{key},create:{key,value:{at:new Date().toISOString(),played}},update:{value:{at:new Date().toISOString(),played}}});sharePointPlayersAt=Infinity;}catch(error){log('SharePoint players failed',error);}
}
async function tick(){
 if(running||stopping)return;running=true;
 try{
   const now=Date.now();
   if(now-lastSync>=config.CRM_SYNC_SECONDS*1000){
     try{await syncContinuously();lastSync=now;}catch(error){log('CRM sync failed',error);}
   }
   await nightly(new Date(now));
   await evidenceRescan(new Date(now));
   await meetingsWithTwenty(now);
   await meetingsBackfill(now);
   await meetingTagsRetry(now);
   await sharePointPlayers(now);
   await teamsTranscripts(now);
   await phoneE164Backfill();
   await sandboxJobs(now);
   try{await launchScheduledCampaigns({actor:SYSTEM_ACTOR});}catch(error){log('campaign launch failed',error);}
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
 await tick();const timer=setInterval(tick,Math.min(config.WORKER_TICK_SECONDS,config.CRM_SYNC_SECONDS,120)*1000);
 const stop=async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,100));await prisma.$disconnect();process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(error=>{console.error('[worker] fatal',error);process.exit(1);});
