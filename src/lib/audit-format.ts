import { formatLocalDate, isLocalDate } from './dates';

/**
 * Plain-language descriptions of audit entries for the person timeline.
 * Never dumps raw JSON at the user: unknown actions fall back to the action name.
 */
/** A stored calendar date, read the way the rest of the app reads it. */
function dateText(value: string | null | undefined): string {
  return value && isLocalDate(value) ? formatLocalDate(value, 'long') : 'an unknown date';
}

type Details = Record<string, unknown> | null | undefined;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (v: unknown) => (typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const words = (v: string) => v.replace(/_/g, ' ');

export type AuditField = { label: string; value: string };

/** One line joining the fields, for a title attribute or a plain-text surface. */
export function auditDetailText(fields: AuditField[]): string | null {
  return fields.length ? fields.map((f) => `${f.label}: ${f.value}`).join(' \u2014 ') : null;
}

export function describeAudit(action: string, details: Details, actorLabel: string | null): { title: string; fields: AuditField[] } {
  const d = (details ?? {}) as Record<string, unknown>;
  const by = actorLabel ? ` by ${actorLabel}` : '';
  const cancelled = num(d.cancelledTasks);
  const closed: AuditField[] = Number.isFinite(cancelled) && cancelled > 0 ? [{ label: 'Open touches closed', value: String(cancelled) }] : [];

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
      if (Number.isFinite(day)) fields.push({ label: 'Business day', value: String(day) });
      if (str(d.dueDate)) fields.push({ label: 'Due', value: dateText(str(d.dueDate)) });
      return { title: `Step ${Number.isFinite(step) ? step + 1 : '?'} scheduled`, fields };
    }
    case 'replied':
      return { title: `Replied${by === ' by twenty:message.created' ? ' (seen in Twenty)' : by}`, fields: closed };
    case 'meeting':
      return { title: 'Meeting booked', fields: [...closed, ...(str(d.evidenceId)?.startsWith('opportunity:') ? [{ label: 'Source', value: 'Opportunity in Twenty' }] : [])] };
    case 'exited': {
      const reason = str(d.reason);
      const label =
        reason === 'bounced'
          ? 'Removed: email bounced'
          : reason === 'opted_out'
            ? 'Removed: asked not to be contacted'
            : reason === 'dnd'
              ? 'Removed: do not contact set in Twenty'
              : reason === 'not_interested'
                ? 'Removed: not interested'
                : reason === 'bad_data'
                  ? 'Removed: bad contact data'
                  : reason === 'person_deleted'
                    ? 'Removed: deleted in Twenty'
                    : reason?.startsWith('campaign_')
                      ? 'Removed: campaign stopped'
                      : `Removed from the sequence${by}`;
      return { title: label, fields: closed };
    }
    case 'completed':
      return { title: 'Finished the sequence (no reply)', fields: Number.isFinite(num(d.steps)) ? [{ label: 'Steps in the plan', value: String(num(d.steps)) }] : [] };
    case 'finished':
      return { title: str(d.kind) === 'replied' ? `Marked as replied${by}` : `Finished by hand${by}`, fields: closed };
    case 'paused': {
      const reason = str(d.reason);
      const why = reason === 'campaign_paused' ? 'Campaign paused' : reason?.startsWith('colleague_replied') ? 'A colleague at this company replied' : reason ? words(reason) : null;
      return { title: `Paused${by}`, fields: why ? [{ label: 'Reason', value: why }] : [] };
    }
    case 'resumed':
      return { title: `Resumed${by}`, fields: Number.isFinite(num(d.pausedDays)) ? [{ label: 'Paused for', value: plural(num(d.pausedDays), 'day') }] : [] };
    case 'moved_to_step': {
      const to = num(d.to);
      return { title: `Moved ahead to step ${Number.isFinite(to) ? to + 1 : '?'}${by}`, fields: closed };
    }
    case 'reassigned':
      return { title: `Reassigned to another FO${by}`, fields: Number.isFinite(num(d.tasks)) ? [{ label: 'Open touches moved', value: String(num(d.tasks)) }] : [] };
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
    default:
      return { title: `${words(action).replace(/^./, (c) => c.toUpperCase())}${by}`, fields: [] };
  }
}
