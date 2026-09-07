/**
 * Plain-language descriptions of audit entries for the person timeline.
 * Never dumps raw JSON at the user: unknown actions fall back to the action name.
 */
type Details = Record<string, unknown> | null | undefined;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (v: unknown) => (typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const words = (v: string) => v.replace(/_/g, ' ');

export function describeAudit(action: string, details: Details, actorLabel: string | null): { title: string; detail: string | null } {
  const d = (details ?? {}) as Record<string, unknown>;
  const by = actorLabel ? ` by ${actorLabel}` : '';
  const cancelled = num(d.cancelledTasks);
  const cancelledNote = Number.isFinite(cancelled) && cancelled > 0 ? `${plural(cancelled, 'open task')} closed` : null;

  switch (action) {
    case 'enrolled': {
      const bits = [str(d.startDate) ? `starts ${str(d.startDate)}` : null, str(d.assignedBy) ? `assigned ${words(str(d.assignedBy)!)}` : null].filter(Boolean);
      return { title: `Enrolled in a sequence${by}`, detail: bits.length ? bits.join(' · ') : null };
    }
    case 'step_generated': {
      const step = num(d.stepIndex);
      const day = num(d.day);
      return { title: `Step ${Number.isFinite(step) ? step + 1 : '?'} scheduled`, detail: Number.isFinite(day) ? `Day ${day} · due ${str(d.dueDate) ?? 'unknown'}` : null };
    }
    case 'replied':
      return { title: `Replied${by === ' by twenty:message.created' ? ' (seen in Twenty)' : by}`, detail: cancelledNote };
    case 'meeting':
      return { title: 'Meeting booked', detail: [cancelledNote, str(d.evidenceId)?.startsWith('opportunity:') ? 'from an opportunity in Twenty' : null].filter(Boolean).join(' · ') || null };
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
      return { title: label, detail: cancelledNote };
    }
    case 'completed':
      return { title: 'Finished the sequence (no reply)', detail: Number.isFinite(num(d.steps)) ? `${plural(num(d.steps), 'step')} in the plan` : null };
    case 'finished':
      return { title: str(d.kind) === 'replied' ? `Marked as replied${by}` : `Finished by hand${by}`, detail: cancelledNote };
    case 'paused': {
      const reason = str(d.reason);
      return { title: `Paused${by}`, detail: reason === 'campaign_paused' ? 'campaign paused' : reason?.startsWith('colleague_replied') ? 'a colleague at this company replied' : reason ? words(reason) : null };
    }
    case 'resumed':
      return { title: `Resumed${by}`, detail: Number.isFinite(num(d.pausedDays)) ? `paused for ${plural(num(d.pausedDays), 'day')}` : null };
    case 'moved_to_step': {
      const to = num(d.to);
      return { title: `Moved ahead to step ${Number.isFinite(to) ? to + 1 : '?'}${by}`, detail: cancelledNote };
    }
    case 'reassigned':
      return { title: `Reassigned to another FO${by}`, detail: Number.isFinite(num(d.tasks)) ? `${plural(num(d.tasks), 'open task')} moved` : null };
    case 'flags_updated': {
      const on = Object.entries(d)
        .filter(([, v]) => v === true)
        .map(([k]) => (k === 'optedOut' ? 'opted out' : k === 'badEmail' ? 'bad email' : k === 'badPhone' ? 'bad phone' : words(k)));
      const off = Object.entries(d)
        .filter(([, v]) => v === false)
        .map(([k]) => (k === 'optedOut' ? 'opt-out' : k === 'badEmail' ? 'bad email' : k === 'badPhone' ? 'bad phone' : words(k)));
      const parts = [on.length ? `set ${on.join(', ')}` : null, off.length ? `cleared ${off.join(', ')}` : null].filter(Boolean);
      return { title: `Flags updated${by}`, detail: parts.join(' · ') || null };
    }
    default:
      return { title: `${words(action).replace(/^./, (c) => c.toUpperCase())}${by}`, detail: null };
  }
}
