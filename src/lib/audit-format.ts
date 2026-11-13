import { formatLocalDate, isLocalDate } from './dates';
import { optionLabel } from './twenty/labels';

/**
 * Plain-language descriptions of audit entries for the Activity feed and the person timeline.
 * Never dumps raw JSON at the user. Every action Cadence writes has its own words (tests/
 * cold-outreach-activity.test.ts reads every logAudit call and migration to check); an unknown one
 * falls back to the action name, and says so with `known: false`.
 */
/** A stored calendar date, read the way the rest of the app reads it. */
function dateText(value: string | null | undefined): string {
  return value && isLocalDate(value) ? formatLocalDate(value, 'long') : 'an unknown date';
}

type Details = Record<string, unknown> | null | undefined;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (v: unknown) => (typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const words = (v: string) => {
  const t = v.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export type AuditField = { label: string; value: string };
export type AuditWords = { title: string; fields: AuditField[]; /** False when the action has no words of its own yet. */ known: boolean };

/** One line joining the fields, for a title attribute or a plain-text surface. */
export function auditDetailText(fields: AuditField[]): string | null {
  return fields.length ? fields.map((f) => `${f.label}: ${f.value}`).join(' — ') : null;
}

/** Where an opt-out came from (transitions.ts OptOutSource), in words. */
const OPT_OUT_FROM: Record<string, string> = {
  call_form: 'the post-call form', contact_page: 'the contact page', person_page: 'the person page', suppression_list: 'the suppression list',
  skip_reason: 'a step skipped as "Asked not to be contacted"', erase: 'an erase', bellwether: 'Bellwether',
};

/** How a step was seen done, from its evidence (N036): Outlook's sent items, or the CRM. */
export function seenWords(evidenceId: string | null | undefined): string {
  return evidenceId?.startsWith('graph:') ? 'seen in Outlook sent items' : 'seen in the CRM';
}

/**
 * Actions whose words need nothing from their details: the title, before " by <who>". Entity-specific
 * ones are keyed "<entityType>:<action>" and win over the plain key.
 */
const TITLES: Record<string, string> = {
  // A cold contact: in, worked, handed on, out (W2, W3, W5).
  'sandbox_contact:created': 'Added to Cold outreach',
  pushed: 'Sent from Bellwether',
  filled_from_push: 'Details filled in from Bellwether',
  edited: 'Details edited',
  note_added: 'Note added',
  claimed: 'Claimed',
  assigned: 'Given to a new owner',
  released: 'Let go',
  pod_set: 'Pod changed',
  pod_set_by_migration: 'Pod set when the release went out',
  work_given_to_owner: 'Its next step and campaigns given back to its owner when the release went out',
  possible_duplicate_marked: 'Marked as possibly the same as another contact',
  released_by_migration: 'Let go when the release went out: its owner cannot own contacts',
  opt_out_lifted: 'Opt-out lifted',
  erased: 'Details erased at their request',
  erased_at_backfill: 'When it was erased recorded for Bellwether',
  move_queued: 'Queued to move to the CRM',
  sandbox_moved: 'Moved to the CRM',
  move_done: 'Move to the CRM finished',
  move_undone: 'Move to the CRM undone',
  move_undo_finished: 'Undo of the move finished',
  sandbox_in_crm: 'Found in the CRM: its outreach stopped',
  sandbox_in_crm_cleared: 'No longer found in the CRM',
  crm_auto_person_removed: 'Person the CRM made from an email removed',
  crm_auto_person_would_remove: 'Person the CRM made from an email: would be removed',
  crm_auto_person_kept: 'Person the CRM made from an email: kept, someone worked them',
  bellwether_do_not_contact: 'Marked Do not contact in Bellwether',
  suggestion_accepted: 'Suggested next step accepted',
  // Email (W10).
  email_bounced: 'Email bounced',
  possible_bounce: 'Possible bounce',
  possible_bounce_cleared: 'Possible bounce cleared: the address is fine',
  possible_bounce_confirmed: 'Bounce confirmed',
  possible_bounce_backfill: 'Possible bounce noted when the release went out',
  email_counted_once: 'Email counted once: this is the copy of a cold outreach email',
  reply_counted_once: 'Reply counted once: the rep\'s "They replied" and the email are one reply',
  // Next steps.
  next_action_recreated: 'Next step reopened in the CRM after the move',
  next_actions_reassigned: 'Next steps handed on',
  deduped_by_migration: 'Duplicate closed when the release went out',
  // Calls and their forms (W4).
  call_logged: 'Call logged',
  call_placed: 'Call started from Cadence',
  call_discarded: 'Call discarded as a mistake',
  contact_chosen: 'Who the call was with chosen',
  rep_chosen: 'Rep given to the call',
  form_reassigned: 'Call form handed to a colleague',
  form_closed: 'Call form closed without a form',
  import_failed: 'Call import failed',
  // Tickets (D4) and meeting number checks.
  'ticket:raised': 'Ticket raised: "Think this is wrong?"',
  'numberCheck:raised': 'Meeting number check raised',
  'numberCheck:closed': 'Meeting number check closed',
  reopened: 'Meeting number check reopened',
  // Campaigns (W7).
  approval_requested: 'Sent for approval',
  approved: 'Approved',
  rejected: 'Declined',
  approval_removed: 'Back to draft: cold campaigns need no approval',
  back_to_draft: 'Back to draft: cold campaigns are built in the campaign studio',
  studio_plan_added: 'Opened in the campaign studio when the release went out',
  calendar_published: 'Published',
  calendar_republished: 'Published again',
  draft_saved: 'Draft saved',
  ended: 'Ended',
  stopped: 'Stopped',
  restarted: 'Restarted',
  fo_added: 'FO added on the start day',
  'campaign:paused': 'Campaign paused',
  'campaign:resumed': 'Campaign resumed',
  'campaign:updated': 'Campaign edited',
  // Tasks and enrollments.
  cancelled: 'Touch cancelled',
  delegated: 'Handed to a colleague',
  sync_failed: 'Could not be written to the CRM',
  repeated: 'Step repeated',
  'enrollment:restored': 'Put back in the campaign by an Undo',
  // Meetings.
  'meeting:created': 'Meeting added',
  'meeting:updated': 'Meeting edited',
  'meeting:deleted': 'Meeting deleted',
  analysed: 'Meeting analysed',
  attendees_updated: 'Attendees updated',
  transcript_saved: 'Transcript saved',
  prospects_linked: 'Prospects linked to the meeting',
  plan_updated: 'Sequence plan updated',
  // Administration (not in Activity, but never a raw name).
  'user:created': 'Team member added',
  'user:removed': 'Access removed',
  'user:restored': 'Access given back',
  'pod:created': 'Pod added',
  'pod:restored': 'Pod restored',
  created_from_twenty_options: 'Pod added from the CRM',
  discovered: 'Pod found in the CRM',
  archived: 'Pod archived',
  blocked: 'Account blocked',
  unblocked: 'Account unblocked',
  enabled: 'Turned on',
  joined: 'Joined through Microsoft',
  login: 'Signed in',
  logout: 'Signed out',
  admin_login_failed: 'Admin sign-in failed',
  caller_number_set: 'Calling number set',
  caller_number_released: 'Calling number released',
  caller_number_moved: 'Calling number moved to the replacement',
  reconcile_ran: 'Checked against the CRM',
  webhook_registered: 'CRM webhook registered',
  'settings:updated': 'Settings changed',
  api_key_created: 'Read API key created',
  api_key_revoked: 'Read API key revoked',
  suppression_added: 'Added to the suppression list',
  teams_transcript_fetch: 'Teams transcript asked of Microsoft',
  recording_looked_up: 'Recording looked up in Microsoft 365',
  suppression_widened: 'Old opt-outs covered on every key',
  suppression_rerun_crm: 'Suppression list checked against the CRM',
  cold_outreach_backfill: 'Cold outreach data brought up to date',
  release_checks: 'Cold outreach data checked when the release went out',
  audience_backfill: 'CRM or Cold outreach recorded on past work',
  ingest_failed: 'A CRM event could not be read',
  reviewed: 'CRM event reviewed',
  push_received: 'Push received from Bellwether',
  push_swept: 'A push from Bellwether stopped part-way and was marked failed',
  suppress_received: 'Do not contact received from Bellwether',
  enriched: 'Details enriched',
};

export function describeAudit(action: string, details: Details, actorLabel: string | null, entityType?: string | null): AuditWords {
  const r = describe(action, details, actorLabel, entityType ?? null);
  return { ...r, known: r.known ?? true };
}

function describe(action: string, details: Details, actorLabel: string | null, entityType: string | null): { title: string; fields: AuditField[]; known?: boolean } {
  const d = (details ?? {}) as Record<string, unknown>;
  const by = actorLabel ? ` by ${actorLabel}` : '';
  const cancelled = num(d.cancelledTasks);
  const closed: AuditField[] = Number.isFinite(cancelled) && cancelled > 0 ? [{ label: 'Touches closed', value: String(cancelled) }] : [];
  const titled = (entityType && TITLES[`${entityType}:${action}`]) ?? TITLES[action];

  switch (action) {
    case 'enrolled': {
      const fields: AuditField[] = [];
      if (str(d.startDate)) fields.push({ label: 'Starts', value: dateText(str(d.startDate)) });
      if (str(d.assignedBy)) fields.push({ label: 'Assigned by', value: words(str(d.assignedBy)!) });
      return { title: `Enrolled in a sequence${by}`, fields };
    }
    case 'step_generated': {
      const step = num(d.stepIndex);
      const day = num(d.day);
      const fields: AuditField[] = [];
      if (Number.isFinite(day)) fields.push({ label: 'Day', value: String(day) });
      if (str(d.dueDate)) fields.push({ label: 'Due', value: dateText(str(d.dueDate)) });
      const skipped = d.skipped && typeof d.skipped === 'object' ? Object.keys(d.skipped).length : 0;
      if (skipped) fields.push({ label: 'Made already skipped', value: plural(skipped, 'touch', 'touches') });
      return { title: `Step ${Number.isFinite(step) ? step + 1 : '?'} scheduled`, fields };
    }
    case 'replied':
      return { title: `Replied${by === ' by twenty:message.created' ? ' (seen in the CRM)' : by}`, fields: closed };
    case 'meeting':
      return { title: 'Meeting booked', fields: [...closed, ...(str(d.evidenceId)?.startsWith('opportunity:') ? [{ label: 'Source', value: 'Opportunity in the CRM' }] : [])] };
    case 'exited': {
      const reason = str(d.reason);
      const label =
        reason === 'bounced'
          ? 'Removed: email bounced'
          : reason === 'opted_out'
            ? 'Removed: asked not to be contacted'
            : reason === 'dnd'
              ? 'Removed: Do not contact set in the CRM'
              : reason === 'not_interested'
                ? 'Removed: not interested'
                : reason === 'not_a_prospect'
                ? 'Removed: not a prospect for this product'
                : reason === 'bad_data'
                  ? 'Removed: bad contact data'
                  : reason === 'person_deleted'
                    ? 'Removed: deleted in the CRM'
                    : reason === 'account_blocked'
                      ? 'Removed: account blocked in Cadence'
                      : reason === 'campaign_ended'
                        ? 'Removed: the campaign reached its end date'
                        : reason === 'removed'
                          ? 'Removed from the campaign by hand'
                          : reason === 'moved_to_crm'
                            ? 'Ended: moved to the CRM'
                            : reason === 'taken_out'
                              ? 'Taken out after a call'
                      : reason?.startsWith('campaign_')
                        ? 'Removed: campaign stopped'
                        : `Removed from the sequence${by}`;
      return { title: label, fields: closed };
    }
    case 'completed':
      // A step done (it carries how it was done) is not the sequence finishing. N036: Outlook's
      // sent items or the CRM, by the evidence.
      if (str(d.source)) {
        const how = str(d.source)!.startsWith('OBSERVED') ? seenWords(str(d.evidenceId)) : str(d.source) === 'MANUAL' ? 'marked done' : null;
        const channel = str(d.chosenAction);
        return { title: `Step done${how ? `: ${how}` : ''}${by}`, fields: channel ? [{ label: 'How', value: words(channel).replace(/^./, (c) => c.toUpperCase()) }] : [] };
      }
      return { title: 'Finished the sequence (no reply)', fields: Number.isFinite(num(d.steps)) ? [{ label: 'Steps in the plan', value: String(num(d.steps)) }] : [] };
    case 'finished':
      return { title: str(d.kind) === 'replied' ? `Marked as replied${by}` : `Finished by hand${by}`, fields: closed };
    case 'paused': {
      if (entityType === 'campaign') return { title: `${titled}${by}`, fields: [] };
      const reason = str(d.reason);
      const why = reason === 'campaign_paused' ? 'Campaign paused' : reason?.startsWith('colleague_replied') ? 'A colleague at this company replied' : reason ? words(reason) : null;
      return { title: `Paused${by}`, fields: why ? [{ label: 'Reason', value: why }] : [] };
    }
    case 'resumed':
      if (entityType === 'campaign') return { title: `${titled}${by}`, fields: [] };
      return { title: `Resumed${by}`, fields: Number.isFinite(num(d.pausedDays)) ? [{ label: 'Paused for', value: plural(num(d.pausedDays), 'day') }] : [] };
    case 'moved_to_step': {
      const to = num(d.to);
      return { title: `Moved ahead to step ${Number.isFinite(to) ? to + 1 : '?'}${by}`, fields: closed };
    }
    case 'reassigned': {
      if (entityType === 'sandbox_contact') {
        const why = str(d.reason);
        return { title: `${why === 'team_access_removed' ? 'Handed on when its owner left' : why === 'pod_change' ? 'Handed on with a pod change' : 'Handed to a new owner'}${by}`, fields: [] };
      }
      return { title: `Reassigned to another FO${by}`, fields: Number.isFinite(num(d.tasks)) ? [{ label: 'Touches moved', value: String(num(d.tasks)) }] : [] };
    }
    case 'flags_updated': {
      const on = Object.entries(d)
        .filter(([, v]) => v === true)
        .map(([k]) => (k === 'optedOut' ? 'opted out' : k === 'badEmail' ? 'bad email' : k === 'badPhone' ? 'bad phone' : words(k)));
      const off = Object.entries(d)
        .filter(([, v]) => v === false)
        .map(([k]) => (k === 'optedOut' ? 'opt-out' : k === 'badEmail' ? 'bad email' : k === 'badPhone' ? 'bad phone' : words(k)));
      const fields: AuditField[] = [];
      if (on.length) fields.push({ label: 'Set', value: on.join(', ') });
      if (off.length) fields.push({ label: 'Cleared', value: off.join(', ') });
      return { title: `Flags updated${by}`, fields };
    }
    case 'product_added':
    case 'product_removed':
      return {
        title: `${action === 'product_added' ? 'Product tagged' : 'Product removed'}${by}`,
        fields: str(d.product) ? [{ label: 'Product', value: optionLabel(str(d.product)!) }] : [],
      };
    // Biz Ops set which meeting with a prospect this is, after a number check.
    case 'number_set':
      return { title: `Meeting number set${by}`, fields: Number.isFinite(num(d.to)) ? [{ label: 'Set to', value: String(num(d.to)) }] : [] };
    case 'number_cleared':
      return { title: `Meeting number counted again${by}`, fields: [] };
    // A task created for a person or a cold contact (stored under its old name, next action).
    case 'next_action_set':
    case 'next_action_done':
    case 'next_action_moved':
    case 'next_action_stopped':
    case 'next_action_auto_closed': {
      const verb = { next_action_set: 'Task created', next_action_done: 'Task done', next_action_moved: 'Task moved', next_action_stopped: 'Task stopped', next_action_auto_closed: `Task done: the email was ${seenWords(str(d.evidence) ?? str(d.evidenceId))}` }[action];
      const fields: AuditField[] = [];
      if (str(d.label)) fields.push({ label: 'Task', value: str(d.label)! });
      const day = (v: string) => (isLocalDate(v) ? formatLocalDate(v, 'long') : v);
      if (str(d.dueDate)) fields.push({ label: 'Due', value: day(str(d.dueDate)!) });
      if (str(d.to)) fields.push({ label: 'Moved to', value: day(str(d.to)!) });
      if (str(d.reason)) fields.push({ label: 'Why', value: str(d.reason)! });
      return { title: `${verb}${by}`, fields };
    }
    case 'opted_out': {
      const from = str(d.source);
      return { title: `Opted out${by}`, fields: [...(from ? [{ label: 'From', value: OPT_OUT_FROM[from] ?? words(from) }] : []), ...(str(d.reason) ? [{ label: 'Why', value: str(d.reason)! }] : [])] };
    }
    case 'removed':
      if (entityType === 'user') return { title: `${TITLES['user:removed']}${by}`, fields: [] };
      return { title: d.by === 'retention' ? 'Removed by retention: no activity for a long time' : `Removed from Cold outreach${by}`, fields: [] };
    case 'move_failed':
      return { title: 'Move to the CRM failed', fields: str(d.reason) ? [{ label: 'Why', value: str(d.reason)! }] : str(d.error) ? [{ label: 'Why', value: str(d.error)! }] : [] };
    case 'email_to_do_not_contact':
      return { title: 'Emailed although they must not be contacted', fields: [...(str(d.why) ? [{ label: 'Why not', value: str(d.why)! }] : []), ...(str(d.address) ? [{ label: 'Address', value: str(d.address)! }] : [])] };
    case 'call_form_submitted':
      return { title: `Call form filled in${by}`, fields: str(d.outcome) ? [{ label: 'Outcome', value: words(str(d.outcome)!) }] : [] };
    case 'closed':
      if (entityType === 'numberCheck') return { title: `${TITLES['numberCheck:closed']}${by}`, fields: [] };
      return { title: `Ticket closed${by}`, fields: str(d.outcome) ? [{ label: 'Opt-out', value: str(d.outcome) === 'lifted' ? 'Lifted' : 'Kept' }] : [] };
    case 'raised':
      return { title: `${TITLES[`${entityType}:raised`] ?? TITLES['ticket:raised']}${by}`, fields: [] };
    case 'started': {
      const left = Array.isArray(d.leftOut) ? d.leftOut.length : num(d.leftOut);
      const fields: AuditField[] = [];
      if (Number.isFinite(left) && left > 0) fields.push({ label: 'Left out', value: plural(left, 'contact') });
      if (d.startMoved && typeof d.startMoved === 'object' && str((d.startMoved as Record<string, unknown>).to)) fields.push({ label: 'Start moved to', value: dateText(str((d.startMoved as Record<string, unknown>).to)) });
      return { title: `Campaign started${by}`, fields };
    }
    case 'launch_failed':
      return { title: 'Campaign did not start', fields: str(d.error) ? [{ label: 'Why', value: str(d.error)! }] : [] };
    case 'people_added':
    case 'people_removed': {
      const n = num(d.count ?? d.added ?? d.removed ?? d.people);
      return { title: `${action === 'people_added' ? 'People added' : 'People taken out'}${by}`, fields: Number.isFinite(n) ? [{ label: 'People', value: String(n) }] : [] };
    }
    case 'skipped':
      return { title: `Touch skipped${by}`, fields: str(d.reason) ? [{ label: 'Why', value: str(d.reason)! }] : [] };
    case 'snoozed':
      return { title: `Moved to a later day${by}`, fields: str(d.to) ? [{ label: 'Moved to', value: dateText(str(d.to)) }] : [] };
    case 'created':
    case 'updated':
    case 'deleted':
    case 'restored':
      if (titled) return { title: `${titled}${by}`, fields: [] };
      return { title: `${action === 'created' ? 'Created' : action === 'updated' ? 'Changed' : action === 'deleted' ? 'Deleted' : 'Restored'}${by}`, fields: [] };
    default:
      if (titled) return { title: `${titled}${by}`, fields: [] };
      return { title: `${words(action).replace(/^./, (c) => c.toUpperCase())}${by}`, fields: [], known: false };
  }
}
