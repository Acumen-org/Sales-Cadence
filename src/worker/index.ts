import 'dotenv/config';
import { backfillMeetingsToCrm, meetingSchemaShape, missingMeetingTags, missingTagsNowInCrm } from '../lib/meetings/crm';
import { backfillTeamsTranscripts } from '../lib/meetings/teams-transcript';
import { MEETINGS_CHANGED_KEY, checkMeetingsInCrm } from '../lib/meetings/crm-check';
import { backfillSharePointPlayers } from '../lib/meetings/sharepoint-player';
import { retryFailedWrites, sweepUnwrittenSyncs } from '../lib/engine/sync-retry';
import { pruneActivityEvents, sweepUnprocessedEvents } from '../lib/engine/ingest';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { SYSTEM_ACTOR } from '../lib/audit';
import { pruneReadApiLog } from '../lib/public-api/keys';
import { purgeExpiredSessions } from '../lib/auth/session-purge';
import { runSchedulerTick } from '../lib/engine/tasks';
import { launchScheduledCampaigns } from '../lib/engine/campaigns';
import { syncContinuously } from '../lib/continuous-sync';
import { reconcile } from '../lib/engine/reconcile';
import { snapshotScorecard } from '../lib/enrichment-work';
import { getTwentyClient } from '../lib/twenty';
import { workspaceTimezone } from '../lib/workspace';
import { syncNextActions } from '../lib/next-actions';
import { runMoveQueue } from '../lib/sandbox/move';
import { CLEANUP_EVERY_MS, cleanupSandboxCrmPeople } from '../lib/sandbox/crm-cleanup';
import { syncH00ksNumbers } from '../lib/calls/h00ks';
import { runCrmCheck } from '../lib/sandbox/crm-check';
import { backfillPhoneE164, runSandboxRetention } from '../lib/sandbox/retention';
import { purgeOldPushes, sweepStuckPushes } from '../lib/sandbox/bellwether-api';
import { importTwilioCalls } from '../lib/calls/import';
import { runGraphMail } from '../lib/mail/graph-mail';
import { COLD_OUTREACH_BACKFILL, runColdOutreachBackfill } from '../lib/outreach/backfills';
import { nightlyLoop } from '../lib/nightly';
import { ringHealth } from '../lib/outreach/health';
import { coldOutreachReleaseOnce } from '../lib/outreach/release';
import { runLinkedInPass } from '../lib/linkedin/pass';
import { beatWorker } from '../lib/worker-heartbeat';
import { setCrmRequestPriority } from '../lib/twenty/pace';

const config=env();
const log=(message:string,extra?:unknown)=>console.log('[worker '+new Date().toISOString()+'] '+message,extra??'');
let running=false;let lastSync=0;let lastPurge=0;let stopping=false;let unwrittenAt=0;
/**
 * The nightly catch-up, which the docs have always promised and nothing ran: continuous sync
 * follows a watermark, so an event Twenty never delivered is never noticed. Once a day, in the
 * small hours of the workspace's own clock, the last few days of activity are re-scanned and the
 * person cache is refreshed in full; then the cold outreach CRM check and retention run.
 *
 * N087: they run in a loop of their own (src/lib/nightly.ts), beside the tick, so imports, forms,
 * moves and launches keep their pace while a long CRM check runs. While the nightly talks to the CRM
 * (reconcile, cache refresh) the tick's continuous sync skips its turn rather than racing it. Each
 * run records its start, end and how long each job took under its own marker (B214), which a restart
 * reads, so a finished day is never repeated and a missed one runs at the next tick after the hour.
 */
const nightly=nightlyLoop({hour:config.RECONCILE_HOUR,log,jobs:()=>{
 const now=new Date();
 return [
  {name:'nightly reconcile',crm:true,run:()=>reconcile({actor:SYSTEM_ACTOR,now})},
  // N13: no full cache listing here: the continuous sync makes its own once a day, resumably (N01).
  {name:'enrichment scorecard snapshot',run:()=>snapshotScorecard(now)},
  // Sandbox contacts Twenty gained after the push: flagged, outreach stopped (crm-check.ts).
  // Each run is recorded for Settings > Cold outreach (B168), failed or not; one an admin started is not run twice at once.
  {name:'sandbox crm check',run:async()=>{const result=await runCrmCheck({now,by:'nightly'});if(result.error)throw new Error(result.error);return result.stats;}},
  // Cold outreach retention, always on: contacts nobody works, moved contacts past the undo window, and
  // the record of what it would remove in the next 30 days (Settings > Cold outreach).
  {name:'sandbox retention',run:()=>runSandboxRetention(now)},
  {name:'bellwether push keys forgotten',run:()=>purgeOldPushes(now)},
  {name:'read api log pruned',run:()=>pruneReadApiLog(now)},
  // N21: CRM events past the retention (needs-review ones stay until someone looks).
  {name:'crm events pruned',run:()=>pruneActivityEvents(now)},
 ];
}});
/**
 * Every 2 minutes: reps' numbers copied from h00ks, then calls read from Twilio (read only), and the sales mailboxes read through Graph
 * when GRAPH_MAIL_ENABLED is set. Moves to the CRM go at every tick, paced under Twenty's limit.
 * Every 5 minutes: the sandbox CRM cleanup (src/lib/sandbox/crm-cleanup.ts).
 */
let callsAt=0;let mailAt=0;let crmCleanupAt=0;let healthAt=0;
/** M31: calls are read first in each pass, so forms open within the 2 minutes the screen promises whatever runs after. */
async function callsImport(now:number){
 if(now>=callsAt){callsAt=now+120_000;try{const synced=await syncH00ksNumbers();if(synced.ran&&(synced.changed.length||synced.identitiesAdded||synced.error))log('h00ks numbers',{changed:synced.changed.map((c)=>`${c.name}: ${c.from??'none'} -> ${c.to??'none'}`),identitiesAdded:synced.identitiesAdded,unmatched:synced.unmatched.length,error:synced.error});}catch(error){log('h00ks numbers failed',error);}try{const stats=await importTwilioCalls();if(stats.ran&&(stats.created||stats.forms||stats.recordings||stats.error))log('twilio import',stats);}catch(error){log('twilio import failed',error);}}
}
async function sandboxJobs(now:number){
 try{const moved=await runMoveQueue({pauseMs:1500,autoRetry:true});if(moved.done||moved.failed||moved.dryRun)log('moves to CRM',moved);}catch(error){log('moves to CRM failed',error);}
 // Every 5 minutes: people Twenty's mail or calendar sync created for sandbox contacts, removed when nobody worked them.
 // B012: a Bellwether push cut off part-way (a restart, the database gone) is marked failed; its retry runs it again.
 if(now>=crmCleanupAt){try{const swept=await sweepStuckPushes();if(swept)log('bellwether pushes swept',swept);}catch(error){log('bellwether push sweep failed',error);}}
 if(now>=crmCleanupAt){crmCleanupAt=now+CLEANUP_EVERY_MS;try{const stats=await cleanupSandboxCrmPeople();if(stats.removed||stats.kept||stats.dryRun||stats.errors)log('sandbox CRM cleanup',stats);}catch(error){log('sandbox CRM cleanup failed',error);}}
 // Every 5 minutes: the health card (PLAN 4.7); a line that turns amber rings the admins once.
 if(now>=healthAt){healthAt=now+300_000;try{const rang=await ringHealth(new Date(now));if(rang.length)log('health card amber',rang);}catch(error){log('health check failed',error);}}
 if(now>=mailAt){mailAt=now+120_000;try{const stats=await runGraphMail();if(stats.ran&&(stats.sent||stats.replies||stats.bounces||stats.possibleBounces||stats.alerts||stats.resets||stats.errors.length))log('graph mail',stats);}catch(error){log('graph mail failed',error);}}
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
 * Once, after the cold outreach release: old opt-outs re-hashed under the wider keys, and the
 * suppression list run again against the CRM copy in lower case (src/lib/outreach/backfills.ts). Each
 * step is idempotent, so a run that fails part way simply runs again at the next start.
 */
let coldOutreachBackfillChecked=false;
async function coldOutreachBackfill(){
 if(coldOutreachBackfillChecked)return;coldOutreachBackfillChecked=true;
 if(await prisma.setting.findUnique({where:{key:COLD_OUTREACH_BACKFILL}}))return;
 try{const stats=await runColdOutreachBackfill();log('cold outreach backfill',stats);const value={at:new Date().toISOString(),...stats};await prisma.setting.upsert({where:{key:COLD_OUTREACH_BACKFILL},create:{key:COLD_OUTREACH_BACKFILL,value},update:{value}});}catch(error){log('cold outreach backfill failed',error);}
}
/**
 * Once, after the backfill: the rest of the release's clean-up of the data since 3 Nov (PLAN 9.7):
 * work given back to its owner, opt-outs and campaigns put right, the rest listed in Settings > Cold
 * outreach (src/lib/outreach/release.ts). A run cut short runs again at the next start.
 */
let coldOutreachReleaseChecked=false;
async function coldOutreachRelease(){
 if(coldOutreachReleaseChecked)return;coldOutreachReleaseChecked=true;
 try{const report=await coldOutreachReleaseOnce();if(report)log('cold outreach release clean-up',{drift:report.drift.contacts,optedOut:report.movedWhileOptedOut.count,ended:report.endedForInactive.count,duplicates:report.duplicates.count,bounces:report.doubtedBounces.count});}catch(error){log('cold outreach release clean-up failed',error);}
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
// While some tag is missing in Twenty, look each hour whether an admin has added one by hand; when
// one has, write the meetings again so it fills in without anyone asking (N14: not every hour regardless).
let meetingTagsRetryAt=Date.now()+3_600_000;
async function meetingTagsRetry(now:number){
 if(now<meetingTagsRetryAt)return;meetingTagsRetryAt=now+3_600_000;
 const missing=await missingMeetingTags();if(!missing.length)return;
 try{
  const schema=await (await getTwentyClient()).meetingSchema();
  if(!schema||!missingTagsNowInCrm(schema,missing))return;
  const written=await backfillMeetingsToCrm({all:true});if(written!==null)log('meetings written again for missing tags',written);
 }catch(error){log('meetings tag retry failed',error);}
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
/**
 * N18: the CRM sync, the meeting checks and the meeting rewrites run in a loop of their own beside the
 * tick, as the nightly does, so a long one (a full listing, a rewrite of every meeting) never holds
 * up the scheduler, the write retries, moves, call import or mailbox reading.
 */
let crmRunning=false;
async function crmJobs(now:number){
 if(now-lastSync>=config.CRM_SYNC_SECONDS*1000&&!nightly.crmBusy){
   try{await syncContinuously();lastSync=now;}catch(error){log('CRM sync failed',error);}
 }
 // N03: CRM events saved but cut off before processing (a restart, a deploy) are processed now.
 try{const swept=await sweepUnprocessedEvents();if(swept)log('unprocessed CRM events swept',swept);}catch(error){log('event sweep failed',error);}
 await evidenceRescan(new Date(now));
 await meetingsWithTwenty(now);
 await meetingsBackfill(now);
 await meetingTagsRetry(now);
}
function startCrmJobs(now:number){
 if(crmRunning||stopping)return;crmRunning=true;
 void crmJobs(now).catch((error)=>log('CRM jobs failed',error)).finally(()=>{crmRunning=false;});
}
async function tick(){
 if(running||stopping)return;running=true;
 try{
   const now=Date.now();
   // P01: the heartbeat Nomad checks (/api/health/worker). Stamped as each pass starts, so a pass that hangs goes stale.
   try{await beatWorker(new Date(now));}catch(error){log('heartbeat failed',error);}
    await callsImport(now);
    startCrmJobs(now);
   await nightly.poke(new Date(now)).catch((error)=>log('nightly failed to start',error));
   await sharePointPlayers(now);
   await teamsTranscripts(now);
   await phoneE164Backfill();
   await coldOutreachBackfill();
   await coldOutreachRelease();
   await sandboxJobs(now);
   try{await launchScheduledCampaigns({actor:SYSTEM_ACTOR});}catch(error){log('campaign launch failed',error);}
   // P02: a scheduler failure is logged and the rest of the pass (write retry, next actions, clean-up) still runs.
   try{const stats=await runSchedulerTick({actor:SYSTEM_ACTOR});if(stats.generated||stats.completed)log('scheduler',stats);}catch(error){log('scheduler failed',error);}
   try{const retried=await retryFailedWrites();if(retried.retried)log('twenty write retry',retried);}catch(error){log('twenty write retry failed',error);}
   // N09: CRM writes a click caused that a restart cut off (neither done nor queued) are made now.
   if(now>=unwrittenAt){unwrittenAt=now+300_000;try{const swept=await sweepUnwrittenSyncs(new Date(now));if(swept.tasks||swept.optOuts)log('unwritten CRM writes swept',swept);}catch(error){log('unwritten CRM writes sweep failed',error);}}
   // LinkedIn, as the LinkedIn Console saw it: events in, tasks closed and opened (src/lib/linkedin).
   try{const li=await runLinkedInPass();if(Object.keys(li).length)log('linkedin',li);}catch(error){log('linkedin failed',error);}
   // Next actions: what has not reached Twenty yet, and what people changed there.
   try{const na=await syncNextActions();if(na.pushed||na.failed||na.followed||na.closed)log('next actions',na);}catch(error){log('next actions failed',error);}
   if(now-lastPurge>=3600000){await purgeExpiredSessions();lastPurge=now;}
 }catch(error){log('tick failed',error);}finally{running=false;}
}
async function main(){
 // N12: the worker's CRM requests are background work: they leave room in the minute for reps' clicks.
 setCrmRequestPriority('background');
 log('Continuous sync every '+config.CRM_SYNC_SECONDS+' seconds; nightly reconcile after '+config.RECONCILE_HOUR+':00 '+workspaceTimezone());
 await tick();const timer=setInterval(tick,Math.min(config.WORKER_TICK_SECONDS,config.CRM_SYNC_SECONDS,120)*1000);
 const stop=async()=>{stopping=true;clearInterval(timer);while(running||crmRunning)await new Promise(resolve=>setTimeout(resolve,100));await nightly.settled();await prisma.$disconnect();process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(error=>{console.error('[worker] fatal',error);process.exit(1);});
